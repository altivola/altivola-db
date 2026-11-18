import mysql, {
  type ConnectionOptions,
  type FieldPacket,
  type PoolConnection,
  type PoolOptions,
  type QueryError,
} from 'mysql2'
import { dialects } from '../edit.ts'
import { splitQualified, splitSQL } from '../sqlsplit.ts'
import { type Cell, type Column, type Driver, emptyResult, errorMessage, type Result, type TreeNode } from '../types.ts'
import {
  column,
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

/** mysqlConfig's output: connection options, plus session variables to SET on every new connection. */
export type MySQLConfig = { options: ConnectionOptions; vars: [string, string][] }

// URL parameters that the Go driver knew and that mean nothing here.
const ignoredParams = new Set([
  'parsetime',
  'loc',
  'interpolateparams',
  'multistatements',
  'clientfoundrows',
  'columnswithalias',
  'allownativepasswords',
  'allowoldpasswords',
  'allowallfiles',
  'allowfallbacktoplaintext',
  'checkconnliveness',
  'maxallowedpacket',
  'readtimeout',
  'writetimeout',
  'rejectreadonly',
  'serverpubkey',
  'timetruncate',
  'connectionattributes',
])

/** Reads a Go duration such as 10s, 500ms or 1m30s, in milliseconds. */
export function goDuration(s: string): number {
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy
  let total = 0
  let at = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    total += Number(m[1]) * (units[m[2] ?? ''] ?? 0)
    at = re.lastIndex
  }
  if (!s || at !== s.length) throw new Error(`invalid duration ${JSON.stringify(s)}`)
  return total
}

/**
 * Maps a tls, ssl or ssl-mode parameter to mysql2's ssl option. Go's
 * tls=preferred (TLS when the server offers it) has no mysql2 equivalent and
 * connects without TLS.
 */
function sslOption(value: string): ConnectionOptions['ssl'] | undefined {
  switch (value.toLowerCase()) {
    case 'true':
    case '1':
    case 'verify_ca':
    case 'verify_identity':
      return { rejectUnauthorized: true }
    case 'skip-verify':
    case 'required':
      return { rejectUnauthorized: false }
    case 'false':
    case '0':
    case 'disabled':
    case 'preferred':
      return undefined
  }
  throw new Error(`invalid value / unknown config name: ${value}`)
}

/**
 * Turns mysql://user:pass@host:3306/db?tls=true (or mariadb://) into mysql2
 * options. Every value comes back as raw bytes so it can be shown as text,
 * like the Go driver without parseTime. Parameters the Go driver did not
 * know become session variables, as they did there.
 */
export function mysqlConfig(raw: string): MySQLConfig {
  const u = new URL(raw)
  if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') {
    throw new Error(`not a MySQL URL: ${u.protocol}//...`)
  }
  const options: ConnectionOptions = {
    host: u.hostname.replace(/^\[(.*)\]$/, '$1') || 'localhost',
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
    multipleStatements: false,
    // An UPDATE that sets the value a row already has must count as a hit,
    // or the grid's one-row check would fail.
    flags: ['FOUND_ROWS'],
    rowsAsArray: true,
    typeCast: (field, _next) => field.buffer(),
  }
  const vars: [string, string][] = []
  for (const [key, value] of u.searchParams) {
    const k = key.toLowerCase()
    if (k === 'tls' || k === 'ssl' || k === 'ssl-mode') {
      const ssl = sslOption(value)
      if (ssl) options.ssl = ssl
      else delete options.ssl
    } else if (k === 'charset' || k === 'collation') {
      options.charset = value.split(',')[0]
    } else if (k === 'timeout') {
      options.connectTimeout = goDuration(value)
    } else if (!ignoredParams.has(k)) {
      if (!/^@{0,2}[\w.]+$/.test(key)) throw new Error(`bad session variable ${JSON.stringify(key)}`)
      vars.push([key, value])
    }
  }
  return { options, vars }
}

type Errno = QueryError & { errno?: number }
const errno = (e: unknown) => (e as Errno | undefined)?.errno

/** MySQL's own type name for a result column, as the Go driver reports it. */
export function mysqlTypeName(f: Pick<FieldPacket, 'columnType' | 'characterSet' | 'flags'>): string {
  const binary = f.characterSet === 63
  const flags = typeof f.flags === 'number' ? f.flags : 0
  const unsigned = (flags & 32) !== 0 ? 'unsigned ' : ''
  switch (f.columnType) {
    case 0:
    case 246:
      return 'decimal'
    case 1:
      return `${unsigned}tinyint`
    case 2:
      return `${unsigned}smallint`
    case 3:
      return `${unsigned}int`
    case 4:
      return 'float'
    case 5:
      return 'double'
    case 6:
      return 'null'
    case 7:
      return 'timestamp'
    case 8:
      return `${unsigned}bigint`
    case 9:
      return `${unsigned}mediumint`
    case 10:
    case 14:
      return 'date'
    case 11:
      return 'time'
    case 12:
      return 'datetime'
    case 13:
      return 'year'
    case 15:
    case 253:
      return binary ? 'varbinary' : 'varchar'
    case 16:
      return 'bit'
    case 242:
      return 'vector'
    case 245:
      return 'json'
    case 247:
      return 'enum'
    case 248:
      return 'set'
    case 249:
      return binary ? 'tinyblob' : 'tinytext'
    case 250:
      return binary ? 'mediumblob' : 'mediumtext'
    case 251:
      return binary ? 'longblob' : 'longtext'
    case 252:
      return binary ? 'blob' : 'text'
    case 254:
      if (flags & 256) return 'enum'
      if (flags & 2048) return 'set'
      return binary ? 'binary' : 'char'
    case 255:
      return 'geometry'
  }
  return ''
}

const columnsOf = (fields: FieldPacket[] | undefined) => (fields ?? []).map((f) => column(f.name, mysqlTypeName(f)))

const toRows = (columns: Column[], rows: unknown[][]): Cell[][] =>
  rows.map((row) => row.map((v, i) => sqlText(columns[i]?.type ?? '', v)))

/** Runs a query with parameters on conn and reads every row of its first result set. */
function all(conn: PoolConnection, sql: string, args: Cell[] = []): Promise<Rows> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values: args, rowsAsArray: true }, (err, rows, fields) => {
      if (err) return reject(err)
      const columns = columnsOf(fields as FieldPacket[] | undefined)
      resolve({ columns, rows: Array.isArray(rows) ? toRows(columns, rows as unknown as unknown[][]) : [] })
    })
  })
}

/** Runs a statement on conn and returns the rows it changed. */
function exec(conn: PoolConnection, sql: string, args: Cell[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values: args }, (err, res) => {
      if (err) return reject(err)
      const n = (res as { affectedRows?: number } | undefined)?.affectedRows
      resolve(typeof n === 'number' ? n : 0)
    })
  })
}

/**
 * Connects to MySQL or MariaDB. readOnly makes every session's transactions
 * read-only on the server, on top of the statement check.
 */
export async function openMySQL(url: string, readOnly: boolean): Promise<Driver> {
  const cfg = mysqlConfig(url)
  // MySQL and MariaDB 11.1+ call it transaction_read_only, older MariaDB tx_read_only.
  const tries = readOnly ? ['transaction_read_only', 'tx_read_only'] : ['']
  let lastErr: unknown
  for (const v of tries) {
    const vars: [string, string][] = v ? [...cfg.vars, [v, '1']] : cfg.vars
    const eng = new MySQLEngine(cfg.options, vars)
    try {
      const conn = await eng.acquire()
      conn.release()
      return new SqlDB(eng, readOnly)
    } catch (e) {
      await eng.close()
      lastErr = e
      if (errno(e) === 1193) continue // unknown system variable
      throw e
    }
  }
  throw lastErr
}

const qm = dialects.mysql.quote
const systemSchemas = `('mysql', 'information_schema', 'performance_schema', 'sys')`

class MySQLEngine implements SqlEngine {
  readonly dialect = dialects.mysql
  readonly pool: Queryer
  private p: mysql.Pool
  private ready = new WeakSet<PoolConnection>()

  constructor(
    private options: ConnectionOptions,
    private vars: [string, string][],
  ) {
    const poolOptions: PoolOptions = { ...options, connectionLimit: 4, maxIdle: 4, idleTimeout: 60_000 }
    this.p = mysql.createPool(poolOptions)
    this.p.on('connection', (c) => c.on('error', () => {})) // a dropped idle connection is replaced on next use
    this.pool = { all: (sql, args) => this.with((c) => all(c, sql, args)) }
  }

  split(script: string): string[] {
    return splitSQL(script, { mysql: true })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.p.end(() => resolve()))
  }

  /** A pooled connection with the session variables set. */
  acquire(): Promise<PoolConnection> {
    return new Promise((resolve, reject) => {
      this.p.getConnection(async (err, conn) => {
        if (err) return reject(err)
        if (this.ready.has(conn)) return resolve(conn)
        try {
          // Go's driver sends these the same way, as SET name=value.
          for (const [k, v] of this.vars) await exec(conn, `SET ${k}=${v}`)
          this.ready.add(conn)
          resolve(conn)
        } catch (e) {
          conn.destroy()
          reject(e)
        }
      })
    })
  }

  private async with<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.acquire()
    try {
      return await fn(conn)
    } finally {
      conn.release()
    }
  }

  /** Stops whatever conn is running, from a separate connection. */
  private kill(conn: PoolConnection): Promise<void> {
    const id = conn.threadId
    return new Promise((resolve) => {
      const k = mysql.createConnection({ ...this.options, database: undefined })
      k.on('error', () => {})
      k.query(`KILL QUERY ${Number(id)}`, () => k.end(() => resolve()))
    })
  }

  async session(): Promise<Session> {
    const conn = await this.acquire()
    const withAbort = async <T>(signal: AbortSignal | undefined, run: (kill: () => void) => Promise<T>) => {
      let killing: Promise<void> | undefined
      const kill = () => {
        killing ??= this.kill(conn)
      }
      signal?.addEventListener('abort', kill, { once: true })
      try {
        return await run(kill)
      } finally {
        signal?.removeEventListener('abort', kill)
        // Wait for the kill, so it cannot hit the next statement.
        await killing
      }
    }
    return {
      all: (sql, args) => all(conn, sql, args),
      exec: (stmt, signal) => withAbort(signal, () => exec(conn, stmt)),
      rows: (stmt, limit, signal) =>
        withAbort(
          signal,
          (kill) =>
            new Promise((resolve, reject) => {
              let columns: Column[] | undefined
              const rows: Cell[][] = []
              let truncated = false
              let failed: unknown
              let done = false
              const finish = () => {
                if (done) return
                done = true
                // The kill that cut the rows short shows up as "query interrupted" (1317).
                if (failed && !(truncated && errno(failed) === 1317)) reject(failed)
                else resolve({ columns: columns ?? [], rows, truncated })
              }
              const q = conn.query({ sql: stmt, rowsAsArray: true })
              q.on('fields', (fields: FieldPacket[] | undefined) => {
                if (!columns && fields) columns = columnsOf(fields)
              })
              q.on('result', (row: unknown, index?: number) => {
                if ((index ?? 0) !== 0 || !Array.isArray(row) || truncated || !columns) return
                if (limit > 0 && rows.length >= limit) {
                  // Reading a big table to the end can take minutes: stop the query instead.
                  truncated = true
                  kill()
                  return
                }
                rows.push(toRows(columns, [row])[0] ?? [])
              })
              q.on('error', (e: unknown) => {
                failed ??= e
                setImmediate(finish)
              })
              q.on('end', finish)
            }),
        ),
      release: async () => conn.release(),
    }
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.with(async (conn) => {
      await exec(conn, 'START TRANSACTION')
      try {
        const out = await fn({ all: (sql, args) => all(conn, sql, args), exec: (sql, args) => exec(conn, sql, args) })
        await exec(conn, 'COMMIT')
        return out
      } catch (e) {
        await exec(conn, 'ROLLBACK').catch(() => {})
        throw e
      }
    })
  }

  async tree(): Promise<TreeNode[]> {
    const { rows } = await this.pool.all(`
      select s.schema_name, coalesce(t.table_name, ''), coalesce(t.table_type, '')
      from information_schema.schemata s
      left join information_schema.tables t on t.table_schema = s.schema_name
      where s.schema_name not in ${systemSchemas}
      order by s.schema_name, t.table_name`)
    const out: TreeRow[] = rows.map(([schema, name, typ]) => ({
      group: String(schema),
      name: String(name),
      kind: typ === 'VIEW' ? 'view' : 'table',
      object: `${qm(String(schema))}.${qm(String(name))}`,
    }))
    return groupTree(out, 'database')
  }

  async resolve(q: Queryer, ref: string): Promise<TableRef> {
    const parts = splitQualified(ref)
    let schema: string
    let name: string
    if (parts.length === 1) {
      const cur = (await q.all('select database()')).rows[0]?.[0]
      if (cur === null || cur === undefined) {
        throw new Error(`no database selected, name the table as database.${parts[0]}`)
      }
      schema = String(cur)
      name = parts[0] ?? ''
    } else if (parts.length === 2) {
      schema = parts[0] ?? ''
      name = parts[1] ?? ''
    } else {
      throw new Error(`bad table name ${JSON.stringify(ref)}`)
    }
    const { rows } = await q.all(
      `select table_schema, table_name, table_type from information_schema.tables
      where table_schema = ? and table_name = ?`,
      [schema, name],
    )
    const row = rows[0]
    if (!row) throw new Error(`table ${ref} not found`)
    schema = String(row[0])
    name = String(row[1])
    return {
      schema,
      name,
      isTable: row[2] !== 'VIEW',
      object: `${qm(schema)}.${qm(name)}`,
      cols: await queryStrings(
        q,
        `select column_name from information_schema.columns
        where table_schema = ? and table_name = ? order by ordinal_position`,
        [schema, name],
      ),
      pk: await queryStrings(
        q,
        `select column_name from information_schema.key_column_usage
        where table_schema = ? and table_name = ? and constraint_name = 'PRIMARY' order by ordinal_position`,
        [schema, name],
      ),
    }
  }

  async describe(q: Queryer, t: TableRef): Promise<Result[]> {
    const sections: [string, string][] = [
      [
        'Columns',
        `select column_name as name, column_type as type,
          case when is_nullable = 'YES' then 'true' else 'false' end as nullable,
          column_default as \`default\`,
          case when column_key = 'PRI' then 'true' else 'false' end as primary_key,
          nullif(extra, '') as extra, nullif(column_comment, '') as comment
        from information_schema.columns where table_schema = ? and table_name = ?
        order by ordinal_position`,
      ],
      [
        'Indexes',
        `select index_name as name, case when non_unique = 0 then 'true' else 'false' end as \`unique\`,
          group_concat(column_name order by seq_in_index separator ', ') as columns, index_type as type
        from information_schema.statistics where table_schema = ? and table_name = ?
        group by index_name, non_unique, index_type order by index_name`,
      ],
      [
        'Foreign keys',
        `select constraint_name as name,
          group_concat(column_name order by ordinal_position separator ', ') as columns,
          concat(referenced_table_schema, '.', referenced_table_name, ' (',
            group_concat(referenced_column_name order by ordinal_position separator ', '), ')') as \`references\`
        from information_schema.key_column_usage
        where table_schema = ? and table_name = ? and referenced_table_name is not null
        group by constraint_name, referenced_table_schema, referenced_table_name order by constraint_name`,
      ],
    ]
    const out: Result[] = []
    for (const [title, sql] of sections) out.push(await queryResult(q, title, sql, [t.schema, t.name]))
    return out
  }

  /**
   * Uses EXPLAIN, or EXPLAIN ANALYZE (MySQL 8.0.18+) / ANALYZE (MariaDB)
   * inside a transaction that is rolled back, since both really run the
   * statement.
   */
  async explain(stmt: string, analyze: boolean): Promise<Result> {
    return this.with(async (conn) => {
      const run = async (sql: string) => emptyResult(await all(conn, sql))
      try {
        if (!analyze) return await run(`explain ${stmt}`)
        await exec(conn, 'START TRANSACTION')
        try {
          return await run(`explain analyze ${stmt}`)
        } catch (e) {
          if (errno(e) !== 1064) throw e // a syntax error means MariaDB
          return await run(`analyze ${stmt}`)
        } finally {
          await exec(conn, 'ROLLBACK').catch(() => {})
        }
      } catch (e) {
        return emptyResult({ error: errorMessage(e) })
      }
    })
  }
}
