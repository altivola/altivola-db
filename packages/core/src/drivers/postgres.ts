import pg from 'pg'
import { buildEdit, checkAffected, dialects, editSummary } from '../edit.ts'
import { firstKeyword, splitSQL } from '../sqlsplit.ts'
import {
  type Cell,
  type Changes,
  type Column,
  type Driver,
  type EditInfo,
  emptyResult,
  errorMessage,
  type Result,
  type TreeNode,
} from '../types.ts'

const cursorName = 'altivola_cursor'

// Every value comes back as Postgres' own text form, exactly what psql prints.
const asText = { getTypeParser: () => (v: string) => v }

/** Where a result column comes from, as Postgres reports it. */
type Source = { table: number; attr: number }

type Rows = { columns: Column[]; rows: Cell[][]; src: Source[]; tag: string; rowCount: number | null; command: string }

/** Session details pg keeps to itself: the transaction status and the full command tag. */
type Tracked = pg.PoolClient & { txStatus?: string; lastTag?: string; processID?: number }

type PgConnection = { on(event: string, fn: (msg: { status?: string; text?: string }) => void): void }

function track(client: pg.PoolClient): Tracked {
  const t = client as Tracked
  if (t.txStatus === undefined) {
    t.txStatus = 'I'
    const con = (client as unknown as { connection: PgConnection }).connection
    con.on('readyForQuery', (msg) => {
      t.txStatus = msg.status ?? 'I'
    })
    con.on('commandComplete', (msg) => {
      t.lastTag = msg.text ?? ''
    })
  }
  return t
}

/**
 * libpq treats sslmode=require as "encrypt, do not verify", while pg treats
 * it as verify-full. Saved URLs are written for libpq (psql, pg_dump), so ask
 * pg to read them the libpq way.
 */
export function pgConfig(url: string): pg.PoolConfig {
  let connectionString = url
  if (/[?&]sslmode=/.test(url) && !/[?&]uselibpqcompat=/.test(url)) {
    connectionString += `${url.includes('?') ? '&' : '?'}uselibpqcompat=true`
  }
  return { connectionString, application_name: 'altivola-db', connectionTimeoutMillis: 15_000 }
}

export function pgError(e: unknown): string {
  const err = e as { message?: string; code?: string; severity?: string; detail?: string; hint?: string }
  if (!err?.code || !err.severity) return errorMessage(e)
  let s = `${err.severity}: ${err.message} (SQLSTATE ${err.code})`
  if (err.detail) s += `\nDETAIL: ${err.detail}`
  if (err.hint) s += `\nHINT: ${err.hint}`
  return s
}

/**
 * Opens a pool of up to 4 connections. readOnly sets
 * default_transaction_read_only, a guard against mistakes and not a security
 * boundary: use a read-only role for that.
 */
export async function openPostgres(url: string, readOnly: boolean): Promise<Driver> {
  const cfg = pgConfig(url)
  const pool = new pg.Pool({
    ...cfg,
    max: 4,
    ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  })
  pool.on('error', () => {}) // an idle connection dropped; the next query reconnects
  try {
    await pool.query('select 1')
  } catch (e) {
    await pool.end().catch(() => {})
    throw new Error(pgError(e))
  }
  return new Postgres(pool, cfg)
}

class Postgres implements Driver {
  private typeNames?: Promise<Map<number, string>>

  constructor(
    private pool: pg.Pool,
    private cfg: pg.PoolConfig,
  ) {}

  close() {
    return this.pool.end()
  }

  private types(): Promise<Map<number, string>> {
    this.typeNames ??= this.pool
      .query<{ oid: number; typname: string }>('select oid::int as oid, typname from pg_type')
      .then((r) => new Map(r.rows.map((t) => [t.oid, t.typname])))
      .catch(() => {
        this.typeNames = undefined
        return new Map()
      })
    return this.typeNames
  }

  /** Runs one statement and reads every row as text. */
  private async read(client: pg.PoolClient | pg.Pool, text: string, args?: unknown[]): Promise<Rows> {
    const names = await this.types()
    const out = await client.query({ text, values: args, rowMode: 'array', types: asText })
    // A simple-protocol query that held several statements returns one result each.
    const res = (Array.isArray(out) ? out[out.length - 1] : out) as pg.QueryArrayResult
    const fields = res.fields ?? []
    const tracked = client instanceof pg.Pool ? undefined : (client as Tracked)
    return {
      columns: fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? String(f.dataTypeID) })),
      src: fields.map((f) => ({ table: f.tableID, attr: f.columnID })),
      rows: (res.rows ?? []) as Cell[][],
      tag: tracked?.lastTag || [res.command, res.rowCount].filter((x) => x !== null && x !== undefined).join(' '),
      rowCount: res.rowCount,
      command: res.command ?? '',
    }
  }

  async tree(): Promise<TreeNode[]> {
    const { rows } = await this.pool.query<{ schema: string; rel: string; kind: string; object: string }>(`
      select n.nspname as schema, coalesce(c.relname, '') as rel, coalesce(c.relkind::text, '') as kind,
        coalesce(quote_ident(n.nspname) || '.' || quote_ident(c.relname), '') as object
      from pg_namespace n
      left join pg_class c on c.relnamespace = n.oid
        and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
      order by 1, 2`)
    const kinds: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign' }
    const schemas: TreeNode[] = []
    for (const r of rows) {
      let last = schemas[schemas.length - 1]
      if (!last || last.name !== r.schema) {
        last = { name: r.schema, kind: 'schema', children: [] }
        schemas.push(last)
      }
      // object is quoted only where needed, e.g. public."Order"
      if (r.rel) last.children?.push({ name: r.rel, kind: kinds[r.kind] ?? r.kind, object: r.object })
    }
    return schemas
  }

  async describe(_database: string, object: string): Promise<Result[]> {
    const found = await this.pool.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [object])
    if (!found.rows[0]?.ok) throw new Error(`relation ${object} not found`)
    const sections = [
      {
        title: 'Columns',
        sql: `
          select a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            not a.attnotnull as nullable,
            pg_get_expr(d.adbin, d.adrelid) as default,
            exists (select 1 from pg_index i where i.indrelid = a.attrelid
              and i.indisprimary and a.attnum = any(i.indkey)) as primary_key,
            col_description(a.attrelid, a.attnum) as comment
          from pg_attribute a
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
      },
      {
        title: 'Indexes',
        sql: `
          select c.relname as name, pg_get_indexdef(i.indexrelid) as definition
          from pg_index i join pg_class c on c.oid = i.indexrelid
          where i.indrelid = to_regclass($1)
          order by 1`,
      },
      {
        title: 'Constraints',
        sql: `
          select conname as name, pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = to_regclass($1)
          order by 1`,
      },
    ]
    const out: Result[] = []
    for (const s of sections) {
      const r = await this.read(this.pool, s.sql, [object])
      out.push(emptyResult({ title: s.title, columns: r.columns, rows: r.rows, message: r.tag }))
    }
    return out
  }

  /**
   * Runs the statements on one pooled connection, so session state such as
   * SET, temp tables or an explicit BEGIN carries across them.
   */
  async query(_database: string, q: string, limit: number, signal?: AbortSignal): Promise<Result[]> {
    const stmts = splitSQL(q)
    if (!stmts.length) throw new Error('nothing to run')
    const client = track(await this.pool.connect())
    const cancel = () => void this.cancel(client.processID)
    signal?.addEventListener('abort', cancel)
    let broken = false
    try {
      const out: Result[] = []
      for (const stmt of stmts) {
        if (signal?.aborted) {
          out.push(emptyResult({ statement: stmt, error: 'cancelled' }))
          break
        }
        const r = await this.run(client, stmt, limit)
        out.push(r)
        if (r.error) break
      }
      // A user transaction left open would leak into the next run on this connection.
      if (client.txStatus !== 'I') {
        await client.query('rollback').catch(() => {
          broken = true
        })
        const last = out[out.length - 1]
        if (last && !last.error)
          last.message = `${last.message ?? ''} (open transaction rolled back at the end of the run)`.trim()
      }
      return out
    } catch (e) {
      broken = true
      throw e
    } finally {
      signal?.removeEventListener('abort', cancel)
      client.release(broken)
    }
  }

  /** Cancels whatever the backend with this pid is running, from another connection. */
  private async cancel(pid: number | undefined) {
    if (!pid) return
    const c = new pg.Client(this.cfg)
    try {
      await c.connect()
      await c.query('select pg_cancel_backend($1)', [pid])
    } catch {
      // nothing to cancel, or the server is gone
    } finally {
      await c.end().catch(() => {})
    }
  }

  private async run(client: Tracked, stmt: string, limit: number): Promise<Result> {
    const r = emptyResult({ statement: stmt })
    const start = performance.now()
    try {
      let rows: Rows
      if (['select', 'with', 'values', 'table'].includes(firstKeyword(stmt))) {
        rows = await this.withCursor(client, stmt, limit)
        r.message = `${Math.min(rows.rows.length, limit > 0 ? limit : Infinity)} rows`
      } else {
        rows = await this.read(client, stmt)
        r.message = rows.tag
        if (rows.command !== 'SELECT' && rows.rowCount !== null) r.affected = rows.rowCount
      }
      r.columns = rows.columns
      r.rows = rows.rows
      if (limit > 0 && r.rows.length > limit) {
        r.rows = r.rows.slice(0, limit)
        r.truncated = true
      }
      // Outside a user transaction only: a failed lookup must not abort it.
      if (client.txStatus === 'I') r.edit = await this.editInfo(client, r.columns, rows.src)
    } catch (e) {
      r.error = pgError(e)
    }
    r.ms = Math.round(performance.now() - start)
    return r
  }

  /**
   * Fetches only limit+1 rows of a query, so a SELECT on a huge table does not
   * stream the whole table to us. Statements a cursor cannot hold (SELECT
   * INTO, data-modifying WITH) fall back to running directly.
   */
  private async withCursor(client: Tracked, stmt: string, limit: number): Promise<Rows> {
    const inUserTx = client.txStatus !== 'I'
    if (!inUserTx) await client.query('begin')
    try {
      await client.query(`declare ${cursorName} no scroll cursor for ${stmt}`)
    } catch (e) {
      if (inUserTx) throw e
      await client.query('rollback')
      return this.read(client, stmt)
    }
    const fetch = limit > 0 ? `fetch forward ${limit + 1} from ${cursorName}` : `fetch all from ${cursorName}`
    try {
      const rows = await this.read(client, fetch)
      if (inUserTx) await client.query(`close ${cursorName}`)
      else await client.query('commit')
      return rows
    } catch (e) {
      if (!inUserTx) await client.query('rollback').catch(() => {})
      throw e
    }
  }

  /**
   * Makes a result editable when every column comes straight from one table
   * and the table's primary key is among them. Postgres reports the source
   * table and column of each result column, so aliases are fine.
   */
  private async editInfo(client: pg.PoolClient, cols: Column[], src: Source[]): Promise<EditInfo | undefined> {
    if (!src.length || src.length !== cols.length) return undefined
    const table = src[0]?.table ?? 0
    if (!table || src.some((s) => s.table !== table && s.table !== 0)) return undefined
    let t: { object: string; kind: string; names: string[]; nums: number[]; pk: number[] } | undefined
    try {
      const res = await client.query(
        `select format('%I.%I', n.nspname, t.relname) as object, t.relkind::text as kind,
          array(select attname::text from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped order by attnum) as names,
          array(select attnum::int from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped order by attnum) as nums,
          coalesce((select i.indkey::int2[]::int[] from pg_index i where i.indrelid = t.oid and i.indisprimary), '{}') as pk
        from pg_class t join pg_namespace n on n.oid = t.relnamespace
        where t.oid = $1`,
        [table],
      )
      t = res.rows[0]
    } catch {
      return undefined
    }
    if (!t || (t.kind !== 'r' && t.kind !== 'p') || !t.pk.length) return undefined
    const byNum = new Map(t.nums.map((n, i) => [n, t.names[i] ?? '']))
    const seen = new Set<string>()
    const columns = src.map((s) => {
      let name = s.table === table ? (byNum.get(s.attr) ?? '') : ''
      if (name && seen.has(name)) name = ''
      seen.add(name)
      return name
    })
    const key: string[] = []
    for (const n of t.pk) {
      const name = byNum.get(n) ?? ''
      if (!name || !seen.has(name)) return undefined
      key.push(name)
    }
    return { object: t.object, key, columns }
  }

  /**
   * Writes grid edits in one transaction. Values travel as untyped text
   * parameters, so Postgres casts them to each column's type the same way it
   * would cast '42' in SQL.
   */
  async apply(_database: string, c: Changes): Promise<Result> {
    if (!c.ops.length) throw new Error('no changes')
    const start = performance.now()
    const client = await this.pool.connect()
    let broken = false
    try {
      await client.query('begin')
      try {
        const found = await client.query<{ object: string; kind: string }>(
          `select format('%I.%I', n.nspname, t.relname) as object, t.relkind::text as kind
          from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.oid = to_regclass($1)`,
          [c.object],
        )
        const t = found.rows[0]
        if (!t || (t.kind !== 'r' && t.kind !== 'p')) throw new Error(`table ${c.object} not found`)
        let total = 0
        for (const [i, op] of c.ops.entries()) {
          let stmt: ReturnType<typeof buildEdit>
          try {
            stmt = buildEdit(dialects.postgres, t.object, op)
          } catch (e) {
            throw new Error(`change ${i + 1}: ${errorMessage(e)}`)
          }
          let n: number
          try {
            n = (await client.query(stmt.sql, stmt.args)).rowCount ?? 0
          } catch (e) {
            throw new Error(`change ${i + 1} (${op.op}): ${pgError(e)}`)
          }
          checkAffected(i, op, n)
          total += n
        }
        await client.query('commit')
        return emptyResult({ message: editSummary(c), affected: total, ms: Math.round(performance.now() - start) })
      } catch (e) {
        await client.query('rollback').catch(() => {
          broken = true
        })
        throw e
      }
    } finally {
      client.release(broken)
    }
  }

  /**
   * Explains the first statement. With analyze the statement really runs, so
   * it runs inside a transaction that is rolled back.
   */
  async explain(_database: string, q: string, analyze: boolean): Promise<Result[]> {
    const stmt = splitSQL(q)[0]
    if (!stmt) throw new Error('nothing to explain')
    const client = await this.pool.connect()
    const r = emptyResult({ title: 'Plan', statement: stmt })
    const start = performance.now()
    try {
      await client.query('begin')
      const rows = await this.read(
        client,
        `explain (${analyze ? 'analyze, buffers, format text' : 'format text'}) ${stmt}`,
      )
      r.columns = rows.columns
      r.rows = rows.rows
      r.message = rows.tag
    } catch (e) {
      r.error = pgError(e)
    } finally {
      await client.query('rollback').catch(() => {})
      client.release()
    }
    r.ms = Math.round(performance.now() - start)
    return [r]
  }
}
