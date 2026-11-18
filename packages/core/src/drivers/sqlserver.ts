import sql from 'mssql'
import { dialects } from '../edit.ts'
import { splitQualified, splitTSQL } from '../sqlsplit.ts'
import { type Cell, type Column, type Driver, emptyResult, errorMessage, type Result, type TreeNode } from '../types.ts'
import {
  column,
  goFloat,
  groupTree,
  type Queryer,
  queryResult,
  queryStrings,
  type Session,
  SqlDB,
  type SqlEngine,
  sqlText,
  type TableRef,
  type TreeRow,
  type Tx,
} from './sqldb.ts'

const truthy = (v: string) => ['true', 'yes', '1', 't', 'mandatory'].includes(v.toLowerCase())

/** Reads a whole number of seconds from a URL parameter, in milliseconds. */
function seconds(name: string, v: string): number {
  const n = Number(v)
  if (!/^\d+$/.test(v.trim()) || !Number.isFinite(n)) throw new Error(`invalid ${name} '${v}'`)
  return n * 1000
}

/**
 * Turns the go-mssqldb URL form, sqlserver://user:pass@host:1433/instance?database=app,
 * into an mssql config. Parameter names are case-insensitive, as they were in Go.
 */
export function sqlServerConfig(raw: string): sql.config {
  const u = new URL(raw)
  if (u.protocol !== 'sqlserver:') throw new Error(`not a SQL Server URL: ${u.protocol}//...`)
  const options: NonNullable<sql.config['options']> = {
    // Like go-mssqldb, encrypt is off unless asked for.
    encrypt: false,
    trustServerCertificate: false,
    useUTC: true,
    appName: 'altivola-db',
  }
  const cfg: sql.config = {
    server: u.hostname.replace(/^\[(.*)\]$/, '$1') || 'localhost',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    options,
    arrayRowMode: true,
    connectionTimeout: 15_000,
    requestTimeout: 0,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
  }
  const instance = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (u.port) cfg.port = Number(u.port)
  else if (instance) options.instanceName = instance
  else cfg.port = 1433
  for (const [key, value] of u.searchParams) {
    switch (key.toLowerCase()) {
      case 'database':
      case 'initial catalog':
        cfg.database = value
        break
      case 'user id':
        cfg.user = value
        break
      case 'password':
        cfg.password = value
        break
      case 'encrypt': {
        const v = value.toLowerCase()
        if (v === 'strict') options.encrypt = 'strict' as unknown as boolean
        else if (v === 'disable') options.encrypt = false
        else options.encrypt = truthy(v)
        break
      }
      case 'trustservercertificate':
        options.trustServerCertificate = truthy(value)
        break
      case 'app name':
        options.appName = value
        break
      case 'connection timeout':
      case 'dial timeout':
        cfg.connectionTimeout = seconds(key, value) || 15_000
        break
    }
  }
  return cfg
}

/**
 * Connects to SQL Server. readOnly is enforced by the statement check only:
 * SQL Server has no session switch for it. Use a login with read access for
 * a hard guarantee.
 */
export async function openSQLServer(url: string, readOnly: boolean): Promise<Driver> {
  const pool = new sql.ConnectionPool(sqlServerConfig(url))
  pool.on('error', () => {}) // a dropped idle connection is replaced on next use
  try {
    await pool.connect()
  } catch (e) {
    await pool.close().catch(() => {})
    throw e
  }
  return new SqlDB(new SQLServerEngine(pool), readOnly)
}

/** What mssql tells about a result column. */
type ColumnMeta = {
  name: string
  type?: { declaration?: string }
  scale?: number
}

const typeName = (c: ColumnMeta) => {
  const t = c.type?.declaration ?? ''
  return t === 'variant' ? 'sql_variant' : t
}

/** A value as text, like the Go driver's: exact decimals, Go float format, times without a zone. */
function cellText(c: ColumnMeta, v: unknown): Cell {
  const t = typeName(c)
  if (typeof v === 'number') {
    if (t === 'float') return goFloat(v, 64)
    if (t === 'real') return goFloat(v, 32)
    if (t === 'decimal' || t === 'numeric') return v.toFixed(c.scale ?? 0)
    if (t === 'money' || t === 'smallmoney') return v.toFixed(4)
  }
  return sqlText(t, v)
}

/** A row as an array; FOR JSON / FOR XML results come back as an object with one key. */
const rowValues = (row: unknown): unknown[] =>
  Array.isArray(row) ? row : Object.values((row ?? {}) as Record<string, unknown>)

const toRows = (meta: ColumnMeta[], rows: unknown[]): Cell[][] =>
  rows.map((row) => rowValues(row).map((v, i) => cellText(meta[i] ?? { name: '' }, v)))

const columnsOf = (meta: ColumnMeta[], typed = true): Column[] =>
  meta.map((c) => column(c.name, typed ? typeName(c) : ''))

type Recordset = unknown[] & { columns?: ColumnMeta[] }

const metaOf = (rs: Recordset | undefined): ColumnMeta[] => rs?.columns ?? []

type Parent = sql.ConnectionPool | sql.Transaction

function request(parent: Parent, args: Cell[] = []): sql.Request {
  const r = new sql.Request(parent as sql.ConnectionPool)
  r.arrayRowMode = true
  args.forEach((a, i) => {
    r.input(`p${i + 1}`, a)
  })
  return r
}

/** A Queryer over any mssql parent: the pool, a transaction or a pinned connection. */
function queryer(parent: Parent): Queryer {
  return {
    all: async (q, args = []) => {
      const res = await request(parent, args).query(q)
      const rs = res.recordsets as unknown as Recordset[]
      const first = rs[0]
      const meta = metaOf(first)
      return { columns: columnsOf(meta), rows: toRows(meta, first ?? []) }
    },
  }
}

const sum = (ns: number[] | undefined) => (ns ?? []).reduce((a, b) => a + b, 0)

/** A tedious connection, as far as this file uses it. */
type TdsConnection = { reset(cb: (err?: Error) => void): void; close(): void }

class SQLServerEngine implements SqlEngine {
  readonly dialect = dialects.sqlserver
  readonly pool: Queryer

  constructor(private p: sql.ConnectionPool) {
    this.pool = queryer(p)
  }

  split(script: string): string[] {
    return splitTSQL(script)
  }

  close(): Promise<void> {
    return this.p.close()
  }

  /**
   * Takes one connection out of the pool and returns an mssql parent that
   * runs every request on it, the way a Transaction does, but without a
   * transaction around them.
   */
  private async pin(): Promise<{ parent: Parent; done: () => Promise<void> }> {
    const pool = this.p as unknown as {
      acquire(requester: unknown): Promise<TdsConnection>
      release(c: TdsConnection): void
      config: unknown
    }
    const conn = await pool.acquire(this)
    const parent = {
      config: pool.config,
      connected: true,
      acquire: (_r: unknown, cb: (err: Error | null, c?: TdsConnection, cfg?: unknown) => void) =>
        setImmediate(cb, null, conn, pool.config),
      release: () => {},
    }
    const done = () =>
      new Promise<void>((resolve) => {
        // Like database/sql, reset the session (USE, SET, temp tables) before the next user gets it.
        conn.reset((err) => {
          if (err) conn.close()
          pool.release(conn)
          resolve()
        })
      })
    return { parent: parent as unknown as Parent, done }
  }

  async session(): Promise<Session> {
    const { parent, done } = await this.pin()
    const cancelOn = (r: sql.Request, signal?: AbortSignal) => {
      const cancel = () => r.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      return () => signal?.removeEventListener('abort', cancel)
    }
    return {
      ...queryer(parent),
      exec: async (stmt, signal) => {
        const r = request(parent)
        const off = cancelOn(r, signal)
        try {
          return sum((await r.batch(stmt)).rowsAffected)
        } finally {
          off()
        }
      },
      rows: (stmt, limit, signal) =>
        new Promise((resolve, reject) => {
          const r = request(parent)
          r.stream = true
          const off = cancelOn(r, signal)
          let sets = 0
          let meta: ColumnMeta[] = []
          const rows: Cell[][] = []
          let truncated = false
          let failed: unknown
          r.on('recordset', (cols: ColumnMeta[]) => {
            if (sets++ === 0) meta = cols
          })
          r.on('row', (row: unknown) => {
            // Only the first result set is read, as in Go.
            if (sets !== 1 || truncated) return
            if (limit > 0 && rows.length >= limit) {
              // Reading a big table to the end can take minutes: cancel the statement instead.
              truncated = true
              r.cancel()
              return
            }
            rows.push(toRows(meta, [row])[0] ?? [])
          })
          r.on('error', (e: unknown) => {
            failed ??= e
          })
          r.on('done', () => {
            off()
            const canceledByUs = truncated && (failed as { code?: string } | undefined)?.code === 'ECANCEL'
            if (failed && !canceledByUs) reject(failed)
            else resolve({ columns: columnsOf(meta), rows, truncated })
          })
          r.batch(stmt)
        }),
      release: done,
    }
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.p)
    await tx.begin()
    try {
      const out = await fn({
        ...queryer(tx),
        exec: async (q, args) => sum((await request(tx, args).query(q)).rowsAffected),
      })
      await tx.commit()
      return out
    } catch (e) {
      await tx.rollback().catch(() => {})
      throw e
    }
  }

  async tree(): Promise<TreeNode[]> {
    const { rows } = await this.pool.all(`
      select s.name, coalesce(o.name, ''), coalesce(rtrim(o.type), ''),
        coalesce(quotename(s.name) + '.' + quotename(o.name), '')
      from sys.schemas s
      left join sys.objects o on o.schema_id = s.schema_id and o.type in ('U', 'V') and o.is_ms_shipped = 0
      where s.name not in ('sys', 'INFORMATION_SCHEMA', 'guest')
        and s.name not like 'db[_]%'
        and (o.object_id is not null or s.name = 'dbo')
      order by s.name, o.name`)
    const out: TreeRow[] = rows.map(([schema, name, typ, object]) => ({
      group: String(schema),
      name: String(name),
      kind: typ === 'V' ? 'view' : 'table',
      object: String(object),
    }))
    return groupTree(out, 'schema')
  }

  /** Lets SQL Server itself parse the name with OBJECT_ID, so every form it accepts (dbo.t, [dbo].[t], t) works. */
  async resolve(q: Queryer, ref: string): Promise<TableRef> {
    splitQualified(ref)
    const { rows } = await q.all(
      `select schema_name(o.schema_id), o.name, rtrim(o.type),
        quotename(schema_name(o.schema_id)) + '.' + quotename(o.name)
      from sys.objects o where o.object_id = object_id(@p1) and o.type in ('U', 'V')`,
      [ref],
    )
    const row = rows[0]
    if (!row) throw new Error(`table ${ref} not found`)
    const object = String(row[3])
    return {
      schema: String(row[0]),
      name: String(row[1]),
      isTable: row[2] === 'U',
      object,
      cols: await queryStrings(q, 'select name from sys.columns where object_id = object_id(@p1) order by column_id', [
        object,
      ]),
      pk: await queryStrings(
        q,
        `select c.name from sys.indexes i
        join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
        join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
        where i.object_id = object_id(@p1) and i.is_primary_key = 1 order by ic.key_ordinal`,
        [object],
      ),
    }
  }

  async describe(q: Queryer, t: TableRef): Promise<Result[]> {
    const sections: [string, string][] = [
      [
        'Columns',
        `select c.name,
          ty.name + case
            when ty.name in ('varchar', 'char', 'varbinary', 'binary')
              then '(' + case when c.max_length = -1 then 'max' else cast(c.max_length as varchar) end + ')'
            when ty.name in ('nvarchar', 'nchar')
              then '(' + case when c.max_length = -1 then 'max' else cast(c.max_length / 2 as varchar) end + ')'
            when ty.name in ('decimal', 'numeric')
              then '(' + cast(c.precision as varchar) + ',' + cast(c.scale as varchar) + ')'
            else '' end as type,
          case when c.is_nullable = 1 then 'true' else 'false' end as nullable,
          object_definition(c.default_object_id) as [default],
          case when exists (select 1 from sys.indexes i
            join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
            where i.object_id = c.object_id and i.is_primary_key = 1 and ic.column_id = c.column_id)
            then 'true' else 'false' end as primary_key,
          case when c.is_identity = 1 then 'identity' end as extra
        from sys.columns c join sys.types ty on ty.user_type_id = c.user_type_id
        where c.object_id = object_id(@p1) order by c.column_id`,
      ],
      [
        'Indexes',
        `select i.name, i.type_desc as type, case when i.is_unique = 1 then 'true' else 'false' end as [unique],
          (select string_agg(c.name, ', ') within group (order by ic.key_ordinal)
            from sys.index_columns ic join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
            where ic.object_id = i.object_id and ic.index_id = i.index_id and ic.is_included_column = 0) as columns
        from sys.indexes i where i.object_id = object_id(@p1) and i.type > 0 order by i.name`,
      ],
      [
        'Foreign keys',
        `select fk.name,
          (select string_agg(c.name, ', ') from sys.foreign_key_columns fc
            join sys.columns c on c.object_id = fc.parent_object_id and c.column_id = fc.parent_column_id
            where fc.constraint_object_id = fk.object_id) as columns,
          quotename(schema_name(r.schema_id)) + '.' + quotename(r.name) as [references]
        from sys.foreign_keys fk join sys.objects r on r.object_id = fk.referenced_object_id
        where fk.parent_object_id = object_id(@p1) order by fk.name`,
      ],
    ]
    const out: Result[] = []
    for (const [title, query] of sections) out.push(await queryResult(q, title, query, [t.object]))
    return out
  }

  /**
   * Turns on SHOWPLAN_TEXT, which returns the estimated plan without running
   * the statement. With analyze the statement runs under STATISTICS PROFILE
   * in a transaction that is rolled back.
   */
  async explain(stmt: string, analyze: boolean): Promise<Result> {
    const { parent, done } = await this.pin()
    const batch = (q: string) => request(parent).batch(q)
    // The plan is the last result set: SHOWPLAN_TEXT first echoes the
    // statement, STATISTICS PROFILE follows the statement's own rows.
    const lastSet = (res: sql.IResult<unknown>): Result => {
      const sets = res.recordsets as unknown as Recordset[]
      const last = sets.filter((s) => metaOf(s).length > 0).at(-1)
      const meta = metaOf(last)
      return emptyResult({ columns: columnsOf(meta, false), rows: toRows(meta, last ?? []) })
    }
    try {
      if (!analyze) {
        await batch('set showplan_text on')
        try {
          return lastSet(await batch(stmt))
        } finally {
          await batch('set showplan_text off').catch(() => {})
        }
      }
      await batch('begin transaction')
      try {
        await batch('set statistics profile on')
        const r = lastSet(await batch(stmt))
        await batch('set statistics profile off').catch(() => {})
        return r
      } finally {
        await batch('if @@trancount > 0 rollback transaction').catch(() => {})
      }
    } catch (e) {
      return emptyResult({ error: errorMessage(e) })
    } finally {
      await done()
    }
  }
}
