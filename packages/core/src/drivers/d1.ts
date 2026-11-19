// Cloudflare D1 over its HTTP API. D1 is SQLite, so the SQL, catalog and
// edits match the SQLite driver; only the transport differs.

import { dialects } from '../edit.ts'
import { splitQualified, splitSQL } from '../sqlsplit.ts'
import type { Cell, Driver, Result, TreeNode } from '../types.ts'
import { emptyResult, errorMessage } from '../types.ts'
import {
  bytesText,
  column,
  goFloat,
  groupTree,
  type Queryer,
  queryResult,
  queryStrings,
  type Rows,
  type Session,
  SqlDB,
  type SqlEngine,
  type TableRef,
  type Tx,
} from './sqldb.ts'

/** Takes d1://<api token>@<account id>/<database id>. */
export function d1Target(raw: string): { token: string; account: string; database: string } {
  const m = /^d1:\/\/([^@/]+)@([^/?#]+)\/([^/?#]+)\/?$/i.exec(raw.trim())
  if (!m) throw new Error('D1 URL looks like d1://<api token>@<account id>/<database id>')
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  return { token: dec(m[1] ?? ''), account: dec(m[2] ?? ''), database: dec(m[3] ?? '') }
}

type Statement = { sql: string; params?: (string | number | null)[] }
type RawResult = { results?: { columns?: string[]; rows?: unknown[][] }; meta?: { changes?: number } }
type ApiReply = { success?: boolean; result?: RawResult[] | null; errors?: { code?: number; message?: string }[] }

const param = (v: Cell): string | number | null => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

/**
 * A grid edit must change exactly one row. D1 cannot hold a transaction open
 * across requests, so edits go out as one batch (which D1 runs atomically)
 * with this check after each statement: json() on a bad string throws and
 * rolls the whole batch back.
 */
const editCheck = `select case when changes() = 1 then 1 else json('altivola-db: edit check') end`

export class D1Client {
  private base: string

  constructor(
    private token: string,
    account: string,
    database: string,
    private fetcher: typeof fetch = fetch,
  ) {
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/raw`
  }

  /** Sends one statement, or a batch that D1 runs as one transaction. */
  async send(body: Statement | { batch: Statement[] }, signal?: AbortSignal): Promise<RawResult[]> {
    let res: Response
    try {
      res = await this.fetcher(this.base, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? null,
      })
    } catch (e) {
      if (signal?.aborted) throw new Error('canceled')
      throw new Error(`could not reach Cloudflare: ${errorMessage(e)}`)
    }
    const reply = (await res.json().catch(() => ({}))) as ApiReply
    if (res.ok && reply.success && reply.result) return reply.result
    const msg = reply.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${msg} (check the API token: it needs the D1 permission for this account)`)
    }
    if (res.status === 404) throw new Error(`${msg} (check the account id and database id)`)
    throw new Error(msg)
  }

  async one(sql: string, args: Cell[] = [], signal?: AbortSignal): Promise<RawResult> {
    const [r] = await this.send({ sql, params: args.map(param) }, signal)
    return r ?? {}
  }
}

/** D1 sends JSON values: integers and floats look the same, blobs are byte arrays. */
function cellText(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : goFloat(v)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return bytesText('', Uint8Array.from(v as number[]))
  return JSON.stringify(v)
}

function rowsOf(r: RawResult, limit: number): Rows & { truncated: boolean } {
  const columns = (r.results?.columns ?? []).map((c) => column(c, ''))
  let rows = r.results?.rows ?? []
  const truncated = limit > 0 && rows.length > limit
  if (truncated) rows = rows.slice(0, limit)
  return { columns, rows: rows.map((row) => row.map(cellText)), truncated }
}

const qt = dialects.sqlite.quote

/** Tables D1 itself keeps in every database. */
const hidden = String.raw`name not like 'sqlite\_%' escape '\' and name not like '\_cf\_%' escape '\'`

export async function openD1(url: string, readOnly: boolean, fetcher?: typeof fetch): Promise<Driver> {
  const t = d1Target(url)
  const client = new D1Client(t.token, t.account, t.database, fetcher)
  await client.one('select 1') // fail on a bad token or id when the connection opens
  return new SqlDB(new D1Engine(client), readOnly)
}

/** D1 has one schema, main. Every request is independent, so a session is just the client. */
class D1Engine implements SqlEngine {
  readonly dialect = dialects.sqlite
  readonly pool: Queryer

  constructor(private client: D1Client) {
    this.pool = { all: async (sql, args = []) => rowsOf(await client.one(sql, args), 0) }
  }

  split(script: string): string[] {
    return splitSQL(script, { brackets: true })
  }

  async close() {}

  async session(): Promise<Session> {
    const c = this.client
    return {
      all: this.pool.all,
      rows: async (stmt, limit, signal) => rowsOf(await c.one(stmt, [], signal), limit),
      exec: async (stmt, signal) => (await c.one(stmt, [], signal)).meta?.changes ?? 0,
      release: async () => {},
    }
  }

  /**
   * Collects the writes and sends them as one batch when fn finishes, each
   * followed by editCheck. Reads inside fn go out right away.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const batch: Statement[] = []
    const out = await fn({
      all: this.pool.all,
      exec: async (sql, args) => {
        batch.push({ sql, params: args.map(param) }, { sql: editCheck })
        return 1
      },
    })
    if (batch.length) {
      try {
        await this.client.send({ batch })
      } catch (e) {
        if (/malformed JSON/i.test(errorMessage(e))) {
          throw new Error(
            'a change did not match exactly 1 row (it was changed or deleted meanwhile), nothing was saved',
          )
        }
        throw e
      }
    }
    return out
  }

  async tree(): Promise<TreeNode[]> {
    const { rows } = await this.pool.all(
      `select name, type from sqlite_master where type in ('table', 'view') and ${hidden} order by name`,
    )
    const out = rows.map(([name, type]) => ({
      group: 'main',
      name: String(name),
      kind: String(type),
      object: qt(String(name)),
    }))
    if (!out.length) out.push({ group: 'main', name: '', kind: '', object: '' })
    return groupTree(out, 'schema')
  }

  async resolve(q: Queryer, ref: string): Promise<TableRef> {
    const parts = splitQualified(ref)
    if (parts.length === 2 && parts[0]?.toLowerCase() !== 'main') throw new Error(`D1 has only the main schema`)
    if (parts.length < 1 || parts.length > 2) throw new Error(`bad table name ${JSON.stringify(ref)}`)
    const name = parts[parts.length - 1] ?? ''
    const { rows } = await q.all(
      `select name, type from sqlite_master where type in ('table', 'view') and name = ? collate nocase`,
      [name],
    )
    const row = rows[0]
    if (!row) throw new Error(`table ${ref} not found`)
    const real = String(row[0])
    return {
      schema: 'main',
      name: real,
      isTable: row[1] === 'table',
      object: qt(real),
      cols: await queryStrings(q, `select name from pragma_table_info(?, 'main') order by cid`, [real]),
      pk: await queryStrings(q, `select name from pragma_table_info(?, 'main') where pk > 0 order by pk`, [real]),
    }
  }

  async describe(q: Queryer, t: TableRef): Promise<Result[]> {
    const sections: [string, string][] = [
      [
        'Columns',
        `select name, type,
          case when "notnull" then 'false' else 'true' end as nullable,
          dflt_value as "default", case when pk > 0 then 'true' else 'false' end as primary_key
        from pragma_table_info(?, 'main') order by cid`,
      ],
      [
        'Indexes',
        `select name, sql as definition from sqlite_master where type = 'index' and tbl_name = ? order by name`,
      ],
      [
        'Foreign keys',
        `select id, "from" as columns, "table" || ' (' || "to" || ')' as "references", on_update, on_delete
        from pragma_foreign_key_list(?, 'main') order by id, seq`,
      ],
    ]
    const out: Result[] = []
    for (const [title, sql] of sections) out.push(await queryResult(q, title, sql, [t.name]))
    return out
  }

  /** EXPLAIN QUERY PLAN, like SQLite. analyze is ignored. */
  async explain(stmt: string): Promise<Result> {
    try {
      return emptyResult(rowsOf(await this.client.one(`explain query plan ${stmt}`), 0))
    } catch (e) {
      return emptyResult({ error: errorMessage(e) })
    }
  }
}
