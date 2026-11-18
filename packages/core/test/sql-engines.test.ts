import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { goDuration, mysqlConfig, mysqlTypeName, openMySQL } from '../src/drivers/mysql.ts'
import { goFloat, groupTree, type Session, sqlText, timeText } from '../src/drivers/sqldb.ts'
import { openSQLite, sqlitePath } from '../src/drivers/sqlite.ts'
import { openSQLServer, sqlServerConfig } from '../src/drivers/sqlserver.ts'
import { type Driver, ReadOnlyError, type Result } from '../src/types.ts'

describe('mysqlConfig', () => {
  it('reads the URL', () => {
    const { options, vars } = mysqlConfig('mysql://ann:p%40ss@db.example:3307/shop')
    expect(options).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'ann',
      password: 'p@ss',
      database: 'shop',
      multipleStatements: false,
      flags: ['FOUND_ROWS'],
    })
    expect(options.ssl).toBeUndefined()
    expect(vars).toEqual([])
  })

  it('defaults the port and takes mariadb://', () => {
    const { options } = mysqlConfig('mariadb://root@localhost')
    expect(options.port).toBe(3306)
    expect(options.database).toBeUndefined()
    expect(options.password).toBe('')
  })

  it('maps tls, timeout and charset, and keeps unknown parameters as session variables', () => {
    const { options, vars } = mysqlConfig(
      "mysql://u@h/db?tls=skip-verify&timeout=1m30s&charset=utf8mb4&parseTime=true&sql_mode='ANSI'",
    )
    expect(options.ssl).toEqual({ rejectUnauthorized: false })
    expect(options.connectTimeout).toBe(90_000)
    expect(options.charset).toBe('utf8mb4')
    expect(vars).toEqual([['sql_mode', "'ANSI'"]])
    expect(mysqlConfig('mysql://u@h/db?tls=true').options.ssl).toEqual({ rejectUnauthorized: true })
    expect(mysqlConfig('mysql://u@h/db?ssl-mode=REQUIRED').options.ssl).toEqual({ rejectUnauthorized: false })
    expect(mysqlConfig('mysql://u@h/db?tls=false').options.ssl).toBeUndefined()
    expect(() => mysqlConfig('mysql://u@h/db?tls=custom')).toThrow('unknown config name')
    expect(() => mysqlConfig('mysql://u@h/db?bad%20name=1')).toThrow('bad session variable')
    expect(() => mysqlConfig('postgres://u@h/db')).toThrow('not a MySQL URL')
  })

  it('reads Go durations', () => {
    expect(goDuration('500ms')).toBe(500)
    expect(goDuration('2s')).toBe(2000)
    expect(() => goDuration('10')).toThrow()
  })

  it('names column types like the Go driver', () => {
    expect(mysqlTypeName({ columnType: 3, characterSet: 63, flags: 0 })).toBe('int')
    expect(mysqlTypeName({ columnType: 8, characterSet: 63, flags: 32 })).toBe('unsigned bigint')
    expect(mysqlTypeName({ columnType: 253, characterSet: 255, flags: 0 })).toBe('varchar')
    expect(mysqlTypeName({ columnType: 253, characterSet: 63, flags: 128 })).toBe('varbinary')
    expect(mysqlTypeName({ columnType: 252, characterSet: 63, flags: 128 })).toBe('blob')
    expect(mysqlTypeName({ columnType: 252, characterSet: 255, flags: 0 })).toBe('text')
    expect(mysqlTypeName({ columnType: 254, characterSet: 255, flags: 256 })).toBe('enum')
  })
})

describe('sqlitePath', () => {
  it.each([
    ['sqlite:///home/me/app.db', '/home/me/app.db', ''],
    ['sqlite://relative.db', 'relative.db', ''],
    ['sqlite:path.db?mode=ro', 'path.db', 'mode=ro'],
    ['file:/tmp/my%20db.sqlite?_pragma=journal_mode(WAL)', '/tmp/my db.sqlite', '_pragma=journal_mode(WAL)'],
    ['sqlite://:memory:', ':memory:', ''],
  ])('%s', (url, path, query) => {
    expect(sqlitePath(url)).toEqual({ path, query })
  })
})

describe('sqlServerConfig', () => {
  it('reads the go-mssqldb URL form', () => {
    const c = sqlServerConfig(
      'sqlserver://sa:Pass%3Bword@db.example:1444?database=app&encrypt=true&TrustServerCertificate=true',
    )
    expect(c).toMatchObject({ server: 'db.example', port: 1444, user: 'sa', password: 'Pass;word', database: 'app' })
    expect(c.options).toMatchObject({ encrypt: true, trustServerCertificate: true })
  })

  it('takes an instance from the path and defaults the rest', () => {
    const c = sqlServerConfig('sqlserver://sa:x@db/SQLEXPRESS')
    expect(c.port).toBeUndefined()
    expect(c.options?.instanceName).toBe('SQLEXPRESS')
    expect(c.options?.encrypt).toBe(false)
    const d = sqlServerConfig('sqlserver://sa:x@db?encrypt=disable&connection+timeout=5')
    expect(d.port).toBe(1433)
    expect(d.connectionTimeout).toBe(5000)
    expect(() => sqlServerConfig('mysql://x')).toThrow('not a SQL Server URL')
  })
})

describe('value text', () => {
  it('formats floats like Go', () => {
    expect(goFloat(1.5)).toBe('1.5')
    expect(goFloat(100000)).toBe('100000')
    expect(goFloat(1234567)).toBe('1.234567e+06')
    expect(goFloat(0.0001)).toBe('0.0001')
    expect(goFloat(0.00001)).toBe('1e-05')
    expect(goFloat(-2.5e-10)).toBe('-2.5e-10')
    expect(goFloat(Math.fround(1.1), 32)).toBe('1.1')
    expect(goFloat(Number.NaN)).toBe('NaN')
    expect(goFloat(Number.NEGATIVE_INFINITY)).toBe('-Inf')
  })

  it('formats times, bytes and others', () => {
    const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 120))
    expect(timeText('datetime2', d)).toBe('2024-01-02 03:04:05.12')
    expect(timeText('datetime2', d, 0.0000345)).toBe('2024-01-02 03:04:05.1200345')
    expect(timeText('date', d)).toBe('2024-01-02')
    expect(timeText('time', new Date(Date.UTC(1970, 0, 1, 10, 0, 0)))).toBe('10:00:00')
    expect(sqlText('varchar', Buffer.from('hé'))).toBe('hé')
    expect(sqlText('blob', Buffer.from('hi'))).toBe('0x6869')
    expect(sqlText('', new Uint8Array([0xff, 0x00]))).toBe('0xFF00')
    expect(sqlText('', 12n)).toBe('12')
    expect(sqlText('bit', true)).toBe('true')
    expect(sqlText('', null)).toBeNull()
  })

  it('groups tree rows', () => {
    expect(
      groupTree(
        [
          { group: 'a', name: 't', kind: 'table', object: 'a.t' },
          { group: 'b', name: '', kind: '', object: '' },
        ],
        'schema',
      ),
    ).toEqual([
      { name: 'a', kind: 'schema', children: [{ name: 't', kind: 'table', object: 'a.t' }] },
      { name: 'b', kind: 'schema' },
    ])
  })
})

// Integration tests against real databases. SQL Server's image is x86 only;
// it runs on Apple Silicon through Docker's emulation. Where it cannot start,
// skip it with SKIP_SQLSERVER=1.

const common = `create table slimdb_items (id int primary key, name varchar(50), qty int, note varchar(100));
  create view slimdb_v as select id, name from slimdb_items;
  insert into slimdb_items values (1, 'ann', 3, 'it''s'), (2, 'bob', null, null), (3, 'cy', 7, 'x;y')`

type Case = {
  name: string
  start: () => Promise<{ url: string; stop: () => Promise<void> }>
  open: (url: string, readOnly: boolean) => Promise<Driver>
  object: string
  group: string
  /** A query that would return a huge number of rows, and what it needs set up first. */
  huge: string
  hugeSetup?: string
  /** Session state: statements whose last one must return "1". */
  sessionState: string
  /** A statement that runs for 10 seconds. */
  slow: string
  /** A way to write past the statement check, to test the server-side guard. */
  serverReadOnly?: boolean
  /** A select of typed values, and the text and column types it must give. */
  values: { sql: string; rows: string[]; types: string[] }
  skip?: boolean
}

const mysqlLike = (image: string): Case['start'] => {
  return async () => {
    const c: StartedMySqlContainer = await new MySqlContainer(image).withDatabase('shop').start()
    return { url: c.getConnectionUri(), stop: () => c.stop().then(() => {}) }
  }
}

const mysqlCase = (name: string, image: string, json: string): Case => ({
  name,
  start: mysqlLike(image),
  open: openMySQL,
  object: '`shop`.`slimdb_items`',
  group: 'shop',
  // MySQL builds a join over information_schema in full before the first row, so use a real table.
  hugeSetup: 'create table big_rows as select ordinal_position as n from information_schema.columns',
  huge: 'select a.* from big_rows a, big_rows b, big_rows c',
  sessionState: 'set @x = 1; create temporary table tmp_x (a int); insert into tmp_x values (@x); select a from tmp_x',
  slow: 'select sleep(10)',
  serverReadOnly: true,
  values: {
    sql: `select cast(1.5 as decimal(10,2)) a, cast('2024-01-02 03:04:05.25' as datetime(2)) b, x'00ff' c,
      cast('2024-01-02' as date) d, 1.5e0 e, 18446744073709551615 f, cast(null as char) g, json_object('k', 1) h`,
    rows: ['1.50', '2024-01-02 03:04:05.25', '0x00FF', '2024-01-02', '1.5', '18446744073709551615', '', '{"k": 1}'],
    types: ['decimal', 'datetime', 'varbinary', 'date', 'double', 'unsigned bigint', 'varchar', json],
  },
})

const cases: Case[] = [
  {
    name: 'sqlite',
    start: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'altivola-sqlite-'))
      const file = join(dir, 'test.db')
      writeFileSync(file, '')
      return { url: `sqlite://${file}`, stop: async () => rmSync(dir, { recursive: true, force: true }) }
    },
    open: openSQLite,
    object: '"main"."slimdb_items"',
    group: 'main',
    huge: 'with recursive c(x) as (select 1 union all select x + 1 from c) select x from c',
    sessionState: 'create temp table tmp_x (a int); insert into tmp_x values (1); select a from tmp_x',
    slow: '',
    serverReadOnly: true,
    values: {
      sql: "select 1.5 a, 1e20 b, x'00ff' c, cast('abc' as blob) d, 42 e, null f, 'x' g, 0.1 h",
      rows: ['1.5', '1e+20', '0x00FF', 'abc', '42', '', 'x', '0.1'],
      types: ['', '', '', '', '', '', '', ''],
    },
  },
  mysqlCase('mysql', 'mysql:8.4', 'json'),
  // MariaDB's JSON is an alias of longtext, sent as varchar.
  mysqlCase('mariadb', 'mariadb:11', 'varchar'),
  {
    name: 'sqlserver',
    skip: process.env.SKIP_SQLSERVER === '1',
    start: async () => {
      const c: StartedMSSQLServerContainer = await new MSSQLServerContainer(
        'mcr.microsoft.com/mssql/server:2022-latest',
      )
        .acceptLicense()
        .start()
      const url = `sqlserver://${c.getUsername()}:${encodeURIComponent(c.getPassword())}@${c.getHost()}:${c.getPort()}?database=master`
      return { url, stop: () => c.stop().then(() => {}) }
    },
    open: openSQLServer,
    object: '[dbo].[slimdb_items]',
    group: 'dbo',
    huge: 'select a.* from sys.all_columns a cross join sys.all_columns b cross join sys.all_columns c',
    sessionState: 'create table #tmp_x (a int); insert into #tmp_x values (1); select a from #tmp_x',
    slow: "waitfor delay '00:00:10'",
    values: {
      sql: `select cast(1.5 as decimal(10,2)) a, cast(12.34 as money) b, cast(1.1 as real) c, cast(1234567 as float) d,
        cast('2024-01-02 03:04:05.1234567' as datetime2) e, cast('2024-01-02' as date) f, 0x00ff g, cast(1 as bit) h,
        cast('6F9619FF-8B86-D011-B42D-00C04FC964FF' as uniqueidentifier) i, cast(9007199254740993 as bigint) j,
        cast('10:11:12.5' as time) k, N'hé' l, cast(null as int) m`,
      rows: [
        '1.50',
        '12.3400',
        '1.1',
        '1.234567e+06',
        '2024-01-02 03:04:05.1234567',
        '2024-01-02',
        '0x00FF',
        'true',
        '6F9619FF-8B86-D011-B42D-00C04FC964FF',
        '9007199254740993',
        '10:11:12.5',
        'hé',
        '',
      ],
      types: [
        'decimal',
        'money',
        'real',
        'float',
        'datetime2',
        'date',
        'varbinary',
        'bit',
        'uniqueidentifier',
        'bigint',
        'time',
        'nvarchar',
        'int',
      ],
    },
  },
]

for (const c of cases) {
  describe.skipIf(c.skip)(c.name, () => {
    let d: Driver
    let url: string
    let stop: (() => Promise<void>) | undefined

    async function must(q: string, limit = 0, db = d): Promise<Result[]> {
      const res = await db.query('', q, limit)
      for (const r of res) if (r.error) throw new Error(`${r.statement}: ${r.error}`)
      return res
    }
    const first = async (q: string, limit = 0) => (await must(q, limit))[0] as Result

    beforeAll(async () => {
      const s = await c.start()
      url = s.url
      stop = s.stop
      d = await c.open(url, false)
      await must(common)
      if (c.hugeSetup) await must(c.hugeSetup)
    }, 300_000)

    afterAll(async () => {
      await d?.close()
      await stop?.()
    }, 60_000)

    it('selects with a limit and marks a table result editable', async () => {
      const r = await first('select * from slimdb_items order by id', 2)
      expect(r.rows).toHaveLength(2)
      expect(r.truncated).toBe(true)
      expect(r.message).toBe('2 rows')
      expect(r.columns[0]?.name).toBe('id')
      expect(r.columns[0]?.type).toMatch(/^int/)
      expect(r.rows[0]?.[3]).toBe("it's")
      expect(r.rows[1]?.[2]).toBeNull()
      expect(r.edit).toMatchObject({ object: c.object, key: ['id'] })
      expect((await first('select * from slimdb_v')).edit).toBeUndefined()
      const count = await first('select count(*) from slimdb_items')
      expect(count.edit).toBeUndefined()
      expect(count.rows[0]?.[0]).toBe('3')
    })

    it('reads values as text like the Go driver', async () => {
      const r = await first(c.values.sql)
      expect(r.rows[0]?.map((v) => v ?? '')).toEqual(c.values.rows)
      expect(r.columns.map((col) => col.type ?? '')).toEqual(c.values.types)
    })

    it('runs statements in order and stops at an error', async () => {
      const res = await d.query(
        '',
        'update slimdb_items set qty = qty where id = 1; select nope from nowhere; select 1',
        0,
      )
      expect(res).toHaveLength(2)
      expect(res[0]?.affected).toBe(1)
      expect(res[0]?.message).toBe('1 rows affected')
      expect(res[1]?.error).toBeTruthy()
      await expect(d.query('', '  ; -- nothing', 0)).rejects.toThrow('nothing to run')
    })

    it('keeps session state across statements', async () => {
      const res = await must(c.sessionState)
      expect(res.at(-1)?.rows).toEqual([['1']])
    })

    it('stops reading a huge result at the limit and keeps the session', async () => {
      const start = Date.now()
      const res = await must(`${c.huge}; select 1`, 5)
      expect(Date.now() - start).toBeLessThan(15_000)
      expect(res[0]?.rows).toHaveLength(5)
      expect(res[0]?.truncated).toBe(true)
      expect(res[1]?.rows).toEqual([['1']])
    }, 30_000)

    it.skipIf(!c.slow)(
      'cancels the running statement when the signal aborts',
      async () => {
        const start = Date.now()
        const res = await d.query('', `${c.slow}; select 1`, 0, AbortSignal.timeout(500))
        expect(Date.now() - start).toBeLessThan(5_000)
        expect(res).toHaveLength(1)
        expect(res[0]?.error).toBe('canceled')
        expect((await first('select 1')).rows).toEqual([['1']])
      },
      20_000,
    )

    it('lists the tree and describes a table', async () => {
      const nodes = await d.tree()
      const group = nodes.find((n) => n.name === c.group)
      const kids = (group?.children ?? [])
        .filter((k) => k.name.startsWith('slimdb_'))
        .map((k) => `${k.kind}:${k.object}`)
      expect(kids).toHaveLength(2)
      expect(kids[0]).toBe(`table:${c.object}`)
      expect(kids[1]).toMatch(/^view:/)
      const res = await d.describe('', c.object)
      expect(res.map((r) => r.title)).toEqual(['Columns', 'Indexes', 'Foreign keys'])
      const cols = res[0] as Result
      expect(cols.rows).toHaveLength(4)
      expect(cols.rows[0]?.[0]).toBe('id')
      expect(cols.rows[0]?.[4]).toBe('true')
      await expect(d.describe('', 'slimdb_items')).resolves.toHaveLength(3)
      await expect(d.describe('', 'nope')).rejects.toThrow('table nope not found')
    })

    it('explains, with and without analyze', async () => {
      for (const analyze of [false, true]) {
        const [r] = await d.explain('', 'select * from slimdb_items where id = 1', analyze)
        expect(r?.error, `analyze=${analyze}`).toBeUndefined()
        expect(r?.title).toBe('Plan')
        expect(r?.rows.length).toBeGreaterThan(0)
      }
      const [bad] = await d.explain('', 'select nope from nowhere', false)
      expect(bad?.error).toBeTruthy()
      // explain analyze runs the statement but rolls it back.
      await d.explain('', 'delete from slimdb_items where id = 3', true)
      expect((await first('select count(*) from slimdb_items where id = 3')).rows[0]?.[0]).toBe('1')
    })

    it('applies edits in one transaction', async () => {
      const r = await d.apply?.('', {
        object: c.object,
        ops: [
          { op: 'update', key: { id: '1' }, values: { name: 'anne', qty: '3' } },
          { op: 'insert', values: { id: '10', name: 'new', qty: null } },
          { op: 'delete', key: { id: '2' } },
        ],
      })
      expect(r?.affected).toBe(3)
      expect(r?.message).toBe('updated 1, inserted 1, deleted 1')
      const got = (await first('select id, name from slimdb_items order by id')).rows
      expect(got).toEqual([
        ['1', 'anne'],
        ['3', 'cy'],
        ['10', 'new'],
      ])
      // A key that matches nothing undoes the whole batch.
      await expect(
        d.apply?.('', {
          object: c.object,
          ops: [
            { op: 'insert', values: { id: '20' } },
            { op: 'update', key: { id: '999' }, values: { name: 'x' } },
          ],
        }),
      ).rejects.toThrow('change 2 (update) matched 0 rows instead of 1, nothing was saved')
      expect((await first('select count(*) from slimdb_items where id = 20')).rows[0]?.[0]).toBe('0')
      // A failing statement names the change and rolls back too.
      await expect(d.apply?.('', { object: c.object, ops: [{ op: 'insert', values: { id: '1' } }] })).rejects.toThrow(
        /^change 1 \(insert\): /,
      )
      await expect(d.apply?.('', { object: 'slimdb_v', ops: [{ op: 'delete', key: { id: '1' } }] })).rejects.toThrow(
        'slimdb_v is not a table',
      )
      await expect(
        d.apply?.('', { object: 'nope; drop table slimdb_items', ops: [{ op: 'delete', key: { id: '1' } }] }),
      ).rejects.toThrow()
      await expect(d.apply?.('', { object: c.object, ops: [] })).rejects.toThrow('no changes')
    })

    it('refuses writes on a read-only connection', async () => {
      const ro = await c.open(url, true)
      try {
        const sel = await must('select * from slimdb_items', 0, ro)
        expect(sel[0]?.edit).toBeUndefined()
        const res = await ro.query('', 'delete from slimdb_items', 0)
        expect(res[0]?.error).toBe('this connection is read-only')
        await expect(
          ro.apply?.('', { object: c.object, ops: [{ op: 'delete', key: { id: '1' } }] }),
        ).rejects.toBeInstanceOf(ReadOnlyError)
        const [ex] = await ro.explain('', 'delete from slimdb_items', true)
        expect(ex?.error).toBe('this connection is read-only')
        if (c.serverReadOnly) {
          // A write that slips past the statement check still fails on the server.
          const eng = (ro as unknown as { eng: { session(): Promise<Session> } }).eng
          const s = await eng.session()
          try {
            await expect(s.exec('insert into slimdb_items (id) values (99)')).rejects.toThrow()
          } finally {
            await s.release()
          }
        }
      } finally {
        await ro.close()
      }
    })
  })
}

describe('sqlite opening', () => {
  it('needs an existing file', async () => {
    await expect(openSQLite('sqlite:///no/such/file.db', false)).rejects.toThrow(
      'sqlite file /no/such/file.db: stat /no/such/file.db: no such file or directory (create it first, e.g. with sqlite3 /no/such/file.db "vacuum")',
    )
    await expect(openSQLite('sqlite://', false)).rejects.toThrow('sqlite URL needs a file path')
  })

  it('opens :memory: with foreign keys on and reads values as text', async () => {
    const d = await openSQLite('sqlite://:memory:', false)
    try {
      const res = await d.query(
        '',
        `create table p (id integer primary key);
        create table c (id integer primary key, p int references p(id), b blob, r real);
        insert into c values (1, 5, x'00ff', 1.5)`,
        0,
      )
      expect(res.at(-1)?.error).toMatch(/FOREIGN KEY/)
      const [r] = await d.query('', "select 9007199254740993 as big, x'00ff' as b, 1234567.0 as f, 'x' as s", 0)
      expect(r?.rows).toEqual([['9007199254740993', '0x00FF', '1.234567e+06', 'x']])
    } finally {
      await d.close()
    }
  })
})
