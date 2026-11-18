// The driver for SQL databases other than Postgres (MySQL/MariaDB, SQLite,
// SQL Server). What differs between them lives in a SqlEngine.

import { buildEdit, checkAffected, editInfoFor, editSummary, type SqlDialect, singleTableSelect } from '../edit.ts'
import { firstKeyword } from '../sqlsplit.ts'
import {
  type Cell,
  type Changes,
  type Column,
  type Driver,
  emptyResult,
  errorMessage,
  ReadOnlyError,
  type Result,
  type TreeNode,
} from '../types.ts'

/** Rows read as text. */
export type Rows = { columns: Column[]; rows: Cell[][] }

/** Something catalog queries can run on: the pool, a session or a transaction. */
export interface Queryer {
  /** Runs a query with parameters and reads every row of its first result set as text. */
  all(sql: string, args?: Cell[]): Promise<Rows>
}

/** An open transaction. */
export interface Tx extends Queryer {
  /** Runs a statement with parameters and returns the number of rows it changed. */
  exec(sql: string, args: Cell[]): Promise<number>
}

/** One dedicated connection, so session state carries from one statement to the next. */
export interface Session extends Queryer {
  /**
   * Runs a statement that returns rows. It reads at most limit rows (0 means
   * all), then stops the statement on the server instead of reading the rest.
   * An aborted signal cancels the statement.
   */
  rows(stmt: string, limit: number, signal?: AbortSignal): Promise<Rows & { truncated: boolean }>
  /** Runs a statement that returns no rows and gives the number of rows it changed. */
  exec(stmt: string, signal?: AbortSignal): Promise<number>
  release(): Promise<void>
}

export type TableRef = {
  /** Canonical quoted reference, e.g. `shop`.`users`. */
  object: string
  schema: string
  name: string
  isTable: boolean
  cols: string[]
  pk: string[]
}

/** The parts of a SQL driver that depend on the database. */
export interface SqlEngine {
  readonly dialect: SqlDialect
  /** Any connection from the pool, for catalog queries. */
  readonly pool: Queryer
  /** Turns a script into statements. */
  split(script: string): string[]
  tree(): Promise<TreeNode[]>
  /**
   * Finds the table or view a user named, quoted or not, and returns its
   * canonical quoted reference with its columns and key.
   */
  resolve(q: Queryer, ref: string): Promise<TableRef>
  describe(q: Queryer, t: TableRef): Promise<Result[]>
  /** Returns the plan of one statement; failures go in Result.error. */
  explain(stmt: string, analyze: boolean): Promise<Result>
  session(): Promise<Session>
  /** Runs fn in a transaction, committed when fn resolves and rolled back when it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Start statements that return rows. */
export const rowKeywords = [
  'select',
  'with',
  'show',
  'describe',
  'desc',
  'explain',
  'values',
  'table',
  'pragma',
  'exec',
  'execute',
  'call',
  'help',
  'analyze',
  'check',
  'checksum',
  'optimize',
  'repair',
]

/**
 * May run on a read-only connection. The server side guards (MySQL's
 * read-only session, SQLite's read-only mode) back this up.
 */
export const readKeywords = [
  'select',
  'with',
  'show',
  'describe',
  'desc',
  'explain',
  'values',
  'table',
  'pragma',
  'use',
  'help',
]

const readOnlyMessage = new ReadOnlyError().message

export class SqlDB implements Driver {
  constructor(
    private eng: SqlEngine,
    private readOnly: boolean,
  ) {}

  close(): Promise<void> {
    return this.eng.close()
  }

  tree(): Promise<TreeNode[]> {
    return this.eng.tree()
  }

  async describe(_database: string, object: string): Promise<Result[]> {
    const ref = await this.eng.resolve(this.eng.pool, object)
    return this.eng.describe(this.eng.pool, ref)
  }

  /**
   * Runs the statements on one connection, so session state such as USE,
   * SET or temp tables carries across them. It stops at the first failing
   * statement.
   */
  async query(_database: string, q: string, limit: number, signal?: AbortSignal): Promise<Result[]> {
    const stmts = this.eng.split(q)
    if (!stmts.length) throw new Error('nothing to run')
    const session = await this.eng.session()
    const out: Result[] = []
    try {
      for (const stmt of stmts) {
        const r = await this.run(session, stmt, limit, signal)
        out.push(r)
        if (r.error) break
      }
    } finally {
      await session.release()
    }
    return out
  }

  private async run(session: Session, stmt: string, limit: number, signal?: AbortSignal): Promise<Result> {
    const r = emptyResult({ statement: stmt })
    const start = performance.now()
    const kw = firstKeyword(stmt)
    try {
      if (signal?.aborted) throw new Error('canceled')
      if (this.readOnly && !readKeywords.includes(kw)) throw new ReadOnlyError()
      if (rowKeywords.includes(kw) || kw.startsWith('sp_')) {
        const got = await session.rows(stmt, limit, signal)
        r.columns = got.columns
        r.rows = got.rows
        r.truncated = got.truncated
        r.message = `${r.rows.length} rows`
        await this.markEditable(session, stmt, r)
      } else {
        const n = await session.exec(stmt, signal)
        r.affected = n
        r.message = `${n} rows affected`
      }
    } catch (e) {
      r.error = errorMessage(e)
    }
    // A cancelled statement may still end without an error (MySQL's SLEEP
    // returns 1 when killed), but its result is not what the user asked for.
    if (signal?.aborted) r.error = 'canceled'
    r.ms = Math.round(performance.now() - start)
    return r
  }

  /** Sets r.edit when stmt is a plain select from one table that has a primary key. */
  private async markEditable(q: Queryer, stmt: string, r: Result) {
    if (this.readOnly || !r.columns.length) return
    const table = singleTableSelect(stmt)
    if (!table) return
    let ref: TableRef
    try {
      ref = await this.eng.resolve(q, table)
    } catch {
      return
    }
    if (!ref.isTable) return
    const edit = editInfoFor(ref.object, '', r.columns, ref.cols, ref.pk)
    if (edit) r.edit = edit
  }

  async explain(_database: string, q: string, analyze: boolean): Promise<Result[]> {
    const stmts = this.eng.split(q)
    const stmt = stmts[0]
    if (stmt === undefined) throw new Error('nothing to explain')
    if (this.readOnly && analyze && !readKeywords.includes(firstKeyword(stmt))) {
      return [emptyResult({ title: 'Plan', statement: stmt, error: readOnlyMessage })]
    }
    const start = performance.now()
    const r = await this.eng.explain(stmt, analyze)
    r.title = 'Plan'
    r.statement = stmt
    r.ms = Math.round(performance.now() - start)
    return [r]
  }

  /** Writes grid edits in one transaction. */
  async apply(_database: string, c: Changes): Promise<Result> {
    if (this.readOnly) throw new ReadOnlyError()
    if (!c.ops.length) throw new Error('no changes')
    const start = performance.now()
    const total = await this.eng.transaction(async (tx) => {
      const ref = await this.eng.resolve(tx, c.object)
      if (!ref.isTable) throw new Error(`${c.object} is not a table`)
      let sum = 0
      for (const [i, op] of c.ops.entries()) {
        let edit: { sql: string; args: Cell[] }
        try {
          edit = buildEdit(this.eng.dialect, ref.object, op)
        } catch (e) {
          throw new Error(`change ${i + 1}: ${errorMessage(e)}`)
        }
        let n: number
        try {
          n = await tx.exec(edit.sql, edit.args)
        } catch (e) {
          throw new Error(`change ${i + 1} (${op.op}): ${errorMessage(e)}`)
        }
        checkAffected(i, op, n)
        sum += n
      }
      return sum
    })
    return emptyResult({ message: editSummary(c), affected: total, ms: Math.round(performance.now() - start) })
  }
}

/** A column, leaving out an unknown type. */
export function column(name: string, type: string): Column {
  return type ? { name, type } : { name }
}

/** Runs a catalog query into a titled Result. */
export async function queryResult(q: Queryer, title: string, sql: string, args: Cell[] = []): Promise<Result> {
  const { columns, rows } = await q.all(sql, args)
  return emptyResult({ title, columns, rows })
}

/** Reads the first column of every row. */
export async function queryStrings(q: Queryer, sql: string, args: Cell[] = []): Promise<string[]> {
  const { rows } = await q.all(sql, args)
  return rows.map((r) => String(r[0] ?? ''))
}

/** A (group, object, kind, ref) row for groupTree. An empty name adds only the group. */
export type TreeRow = { group: string; name: string; kind: string; object: string }

/** Turns rows ordered by group into tree nodes. */
export function groupTree(rows: TreeRow[], groupKind: string): TreeNode[] {
  const out: TreeNode[] = []
  for (const r of rows) {
    let last = out[out.length - 1]
    if (!last || last.name !== r.group) {
      last = { name: r.group, kind: groupKind }
      out.push(last)
    }
    if (r.name) {
      last.children ??= []
      last.children.push({ name: r.name, kind: r.kind, object: r.object })
    }
  }
  return out
}

const binaryTypes = [
  'binary',
  'varbinary',
  'blob',
  'tinyblob',
  'mediumblob',
  'longblob',
  'image',
  'rowversion',
  'geometry',
]

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Bytes as the grid shows them: text when they are valid UTF-8 and the type is not binary, else 0x hex. */
export function bytesText(typ: string, b: Uint8Array): string {
  if (!binaryTypes.includes(typ)) {
    try {
      return utf8.decode(b)
    } catch {
      // not text, fall through to hex
    }
  }
  return `0x${Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex').toUpperCase()}`
}

/**
 * Formats a float the way Go's strconv.FormatFloat(v, 'g', -1, bits) does:
 * the shortest digits that read back as the same value, with an exponent
 * when it is below -4 or at least 6.
 */
export function goFloat(v: number, bits: 32 | 64 = 64): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Number.POSITIVE_INFINITY) return '+Inf'
  if (v === Number.NEGATIVE_INFINITY) return '-Inf'
  if (v === 0) return Object.is(v, -0) ? '-0' : '0'
  let s = v.toExponential()
  if (bits === 32) {
    const f = Math.fround(v)
    for (let p = 0; p < 9; p++) {
      s = f.toExponential(p)
      if (Math.fround(Number(s)) === f) break
    }
  }
  const [mant = '', expText = '0'] = s.split('e')
  const exp = Number(expText)
  if (exp < -4 || exp >= 6) return `${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  const neg = mant.startsWith('-')
  const digits = mant.replace('-', '').replace('.', '')
  const point = exp + 1
  let out: string
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length)
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`
  return (neg ? '-' : '') + out
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/**
 * Formats a time like Go's layouts with .9999999: up to 7 fraction digits,
 * trailing zeros dropped. The date's UTC fields hold the value, as the SQL
 * Server driver returns it. extraSeconds is a fraction of a second beyond
 * the milliseconds.
 */
export function timeText(typ: string, d: Date, extraSeconds = 0): string {
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const ticks = d.getUTCMilliseconds() * 10_000 + Math.round(extraSeconds * 1e7)
  const frac = ticks ? `.${pad(ticks, 7).replace(/0+$/, '')}` : ''
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`
  switch (typ) {
    case 'date':
      return date
    case 'time':
      return time
    case 'datetimeoffset':
      return `${date} ${time} +00:00`
  }
  return `${date} ${time}`
}

/**
 * Turns a driver value into the text the grid shows, like Postgres' text
 * output: numbers and times as strings, bytes as text or hex. Drivers format
 * floats themselves, since only they know a float from an integer.
 */
export function sqlText(typ: string, v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return bytesText(typ, v)
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return timeText(typ, v, (v as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0)
  return JSON.stringify(v)
}
