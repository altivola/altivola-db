import { statSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { dialects } from '../edit.ts'
import { splitQualified, splitSQL } from '../sqlsplit.ts'
import type { Cell, Driver, Result, TreeNode } from '../types.ts'
import { emptyResult, errorMessage } from '../types.ts'
import {
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
  sqlText,
  type TableRef,
  type TreeRow,
  type Tx,
} from './sqldb.ts'

/**
 * Takes sqlite:///abs/path.db, sqlite://relative.db, sqlite:path.db or a
 * file: URI and returns the file path and any query.
 */
export function sqlitePath(raw: string): { path: string; query: string } {
  let s = raw.startsWith('file:') ? raw.slice('file:'.length) : raw.replace(/^sqlite:/, '')
  s = s.replace(/^\/\//, '')
  let query = ''
  const i = s.indexOf('?')
  if (i >= 0) {
    query = s.slice(i + 1)
    s = s.slice(0, i)
  }
  try {
    s = decodeURIComponent(s)
  } catch {
    // keep the path as written
  }
  return { path: s, query }
}

const statErrors: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  ENOTDIR: 'not a directory',
}

/** Runs pragma name(arg) from a _pragma URL parameter, e.g. journal_mode(WAL). */
function pragmaStatement(p: string): string {
  const m = /^\s*([A-Za-z_][\w.]*)\s*(?:\(\s*([\w.-]*)\s*\))?\s*$/.exec(p)
  if (!m) throw new Error(`bad _pragma ${JSON.stringify(p)}`)
  return m[2] === undefined ? `pragma ${m[1]}` : `pragma ${m[1]} = ${m[2]}`
}

/**
 * Opens a database file. The file must exist, so a typo in the path does not
 * quietly create an empty database. readOnly opens it read-only, which
 * SQLite itself enforces.
 */
export async function openSQLite(url: string, readOnly: boolean): Promise<Driver> {
  const { path, query } = sqlitePath(url)
  if (!path) throw new Error('sqlite URL needs a file path, e.g. sqlite:///home/me/app.db')
  if (path !== ':memory:') {
    try {
      statSync(path)
    } catch (e) {
      const code = (e as { code?: string }).code ?? ''
      const why = statErrors[code] ?? errorMessage(e)
      throw new Error(`sqlite file ${path}: stat ${path}: ${why} (create it first, e.g. with sqlite3 ${path} "vacuum")`)
    }
  }
  const params = new URLSearchParams(query)
  const ro = readOnly || params.get('mode') === 'ro'
  const db = new DatabaseSync(path, { readOnly: ro })
  try {
    db.exec('pragma busy_timeout = 5000')
    db.exec('pragma foreign_keys = on')
    for (const p of params.getAll('_pragma')) db.exec(pragmaStatement(p))
  } catch (e) {
    db.close()
    throw e
  }
  return new SqlDB(new SQLiteEngine(db), readOnly)
}

const qt = dialects.sqlite.quote

/** Reads a prepared statement's rows as text, at most limit (0 means all). */
function readRows(st: StatementSync, args: Cell[], limit: number): Rows & { truncated: boolean } {
  st.setReturnArrays(true)
  st.setReadBigInts(true)
  const meta = st.columns()
  const types = meta.map((c) => (c.type ?? '').toLowerCase())
  const columns = meta.map((c, i) => column(c.name, types[i] ?? ''))
  const rows: Cell[][] = []
  let truncated = false
  const it = st.iterate(...(args.map(sqliteArg) as SQLInputValue[]))
  for (const row of it as Iterable<unknown[]>) {
    if (limit > 0 && rows.length >= limit) {
      truncated = true
      break // leaving the loop finalizes the statement without reading the rest
    }
    rows.push(row.map((v, i) => (typeof v === 'number' ? goFloat(v) : sqlText(types[i] ?? '', v))))
  }
  return { columns, rows, truncated }
}

const sqliteArg = (v: Cell): SQLInputValue => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

/**
 * SQLite is in-process and node:sqlite is synchronous, so the whole driver
 * shares one handle: every "session" is the same connection, and a query
 * blocks the event loop while it runs.
 */
class SQLiteEngine implements SqlEngine {
  readonly dialect = dialects.sqlite
  readonly pool: Queryer

  constructor(private db: DatabaseSync) {
    this.pool = { all: async (sql, args = []) => readRows(db.prepare(sql), args, 0) }
  }

  split(script: string): string[] {
    return splitSQL(script, { brackets: true })
  }

  async close() {
    if (this.db.isOpen) this.db.close()
  }

  async session(): Promise<Session> {
    const db = this.db
    return {
      all: this.pool.all,
      rows: async (stmt, limit) => readRows(db.prepare(stmt), [], limit),
      exec: async (stmt) => Number(db.prepare(stmt).run().changes),
      release: async () => {},
    }
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const db = this.db
    db.exec('begin')
    try {
      const out = await fn({
        all: this.pool.all,
        exec: async (sql, args) => Number(db.prepare(sql).run(...args.map(sqliteArg)).changes),
      })
      db.exec('commit')
      return out
    } catch (e) {
      if (db.isTransaction) db.exec('rollback')
      throw e
    }
  }

  private schemas(q: Queryer): Promise<string[]> {
    return queryStrings(q, 'select name from pragma_database_list order by seq')
  }

  async tree(): Promise<TreeNode[]> {
    const out: TreeRow[] = []
    for (const s of await this.schemas(this.pool)) {
      const { rows } = await this.pool.all(String.raw`select name, type from ${qt(s)}.sqlite_master
        where type in ('table', 'view') and name not like 'sqlite\_%' escape '\' order by name`)
      for (const [name, type] of rows) {
        out.push({ group: s, name: String(name), kind: String(type), object: `${qt(s)}.${qt(String(name))}` })
      }
      if (!rows.length && s === 'main') out.push({ group: s, name: '', kind: '', object: '' })
    }
    return groupTree(out, 'schema')
  }

  async resolve(q: Queryer, ref: string): Promise<TableRef> {
    const parts = splitQualified(ref)
    let schemas: string[]
    let name: string
    if (parts.length === 1) {
      schemas = await this.schemas(q)
      name = parts[0] ?? ''
    } else if (parts.length === 2) {
      schemas = [parts[0] ?? '']
      name = parts[1] ?? ''
    } else {
      throw new Error(`bad table name ${JSON.stringify(ref)}`)
    }
    for (const s of schemas) {
      const { rows } = await q.all(
        `select name, type from ${qt(s)}.sqlite_master where type in ('table', 'view') and name = ? collate nocase`,
        [name],
      )
      const row = rows[0]
      if (!row) continue
      const real = String(row[0])
      return {
        schema: s,
        name: real,
        isTable: row[1] === 'table',
        object: `${qt(s)}.${qt(real)}`,
        cols: await queryStrings(q, 'select name from pragma_table_info(?, ?) order by cid', [real, s]),
        pk: await queryStrings(q, 'select name from pragma_table_info(?, ?) where pk > 0 order by pk', [real, s]),
      }
    }
    throw new Error(`table ${ref} not found`)
  }

  async describe(q: Queryer, t: TableRef): Promise<Result[]> {
    const sections: [string, string, Cell[]][] = [
      [
        'Columns',
        `select name, type,
          case when "notnull" then 'false' else 'true' end as nullable,
          dflt_value as "default", case when pk > 0 then 'true' else 'false' end as primary_key
        from pragma_table_info(?, ?) order by cid`,
        [t.name, t.schema],
      ],
      [
        'Indexes',
        `select name, sql as definition from ${qt(t.schema)}.sqlite_master
        where type = 'index' and tbl_name = ? order by name`,
        [t.name],
      ],
      [
        'Foreign keys',
        `select id, "from" as columns, "table" || ' (' || "to" || ')' as "references",
          on_update, on_delete
        from pragma_foreign_key_list(?, ?) order by id, seq`,
        [t.name, t.schema],
      ],
    ]
    const out: Result[] = []
    for (const [title, sql, args] of sections) out.push(await queryResult(q, title, sql, args))
    return out
  }

  /** Uses EXPLAIN QUERY PLAN. SQLite has no analyze variant that keeps the plan readable, so analyze is ignored. */
  async explain(stmt: string): Promise<Result> {
    try {
      const { columns, rows } = readRows(this.db.prepare(`explain query plan ${stmt}`), [], 0)
      return emptyResult({ columns, rows })
    } catch (e) {
      return emptyResult({ error: errorMessage(e) })
    }
  }
}
