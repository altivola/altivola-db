import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPostgres } from '../src/drivers/postgres.ts'
import type { Driver, Result } from '../src/types.ts'

let container: StartedPostgreSqlContainer
let pg: Driver
let url: string

async function must(q: string, limit = 100): Promise<Result[]> {
  const res = await pg.query('', q, limit)
  for (const r of res) if (r.error) throw new Error(`${r.statement}: ${r.error}`)
  return res
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start()
  url = container.getConnectionUri()
  pg = await openPostgres(url, false)
  await must(`
    create schema t;
    create table t.users (id serial primary key, name text not null, age int, tags jsonb);
    create index users_name_idx on t.users (name);
    create view t.adults as select * from t.users where age >= 18;
    create table t.nokey (a int);
    insert into t.users (name, age, tags) values ('ann', 31, '["a"]'), ('bob', null, null), ('cy', 12, '{"k": 1}');`)
}, 120_000)

afterAll(async () => {
  await pg?.close()
  await container?.stop()
})

describe('postgres', () => {
  it('runs several statements in one session', async () => {
    const res = await must("insert into t.users (name) values ('dee'); select name, age from t.users order by id")
    expect(res).toHaveLength(2)
    expect(res[0]?.affected).toBe(1)
    expect(res[0]?.message).toBe('INSERT 0 1')
    const r = res[1]
    expect(r?.rows).toHaveLength(4)
    expect(r?.columns.map((c) => c.type)).toEqual(['text', 'int4'])
    expect(r?.rows[0]).toEqual(['ann', '31'])
    expect(r?.rows[1]?.[1]).toBeNull()
  })

  it('keeps session state across statements', async () => {
    const res = await must(
      "set search_path = t; select count(*) from users; set application_name = 'x'; show application_name",
    )
    expect(res[1]?.rows[0]?.[0]).toBe('4')
    expect(res[3]?.rows[0]?.[0]).toBe('x')
  })

  it('marks truncation at the limit', async () => {
    let r = (await must('select * from generate_series(1, 10)', 3))[0]
    expect(r?.rows).toHaveLength(3)
    expect(r?.truncated).toBe(true)
    r = (await must('select * from generate_series(1, 3)', 3))[0]
    expect(r?.truncated).toBe(false)
  })

  it('falls back from the cursor for a data-modifying WITH', async () => {
    const r = (await must("with x as (insert into t.users (name) values ('eve') returning name) select * from x"))[0]
    expect(r?.rows).toEqual([['eve']])
  })

  it('stops at the first error', async () => {
    const res = await pg.query('', 'select 1; select nope; select 2', 10)
    expect(res).toHaveLength(2)
    expect(res[0]?.error).toBeUndefined()
    expect(res[1]?.error).toMatch(/column "nope" does not exist.*SQLSTATE 42703/)
  })

  it('handles an explicit transaction with a select inside', async () => {
    const res = await must(
      'begin; delete from t.users; select count(*) from t.users; rollback; select count(*) from t.users',
    )
    expect(res[2]?.rows[0]?.[0]).toBe('0')
    expect(res[4]?.rows[0]?.[0]).not.toBe('0')
  })

  it('rolls back a transaction left open at the end of a run', async () => {
    await must('begin; delete from t.users')
    const r = (await must('select count(*) from t.users'))[0]
    expect(r?.rows[0]?.[0]).not.toBe('0')
  })

  it('lists tables and views', async () => {
    const nodes = await pg.tree()
    const schema = nodes.find((n) => n.name === 't')
    expect(schema?.children?.map((c) => `${c.kind}:${c.object}`)).toEqual([
      'view:t.adults',
      'table:t.nokey',
      'table:t.users',
    ])
  })

  it('describes a table', async () => {
    const res = await pg.describe('', 't.users')
    expect(res.map((r) => r.title)).toEqual(['Columns', 'Indexes', 'Constraints'])
    expect(res[0]?.rows[0]?.[0]).toBe('id')
    expect(res[0]?.rows[0]?.[4]).toBe('t')
    expect(res[0]?.rows[1]?.[2]).toBe('f')
    expect(res[1]?.rows).toHaveLength(2)
    await expect(pg.describe('', 't.nope')).rejects.toThrow(/not found/)
  })

  it('makes single-table results editable and applies edits', async () => {
    const r = (await must('select u.name as who, id, age, age + 1 as next from t.users u order by id'))[0]
    expect(r?.edit).toEqual({ object: 't.users', key: ['id'], columns: ['name', 'id', 'age', ''] })
    expect((await must('select name from t.users'))[0]?.edit).toBeUndefined() // no key
    expect((await must('select * from t.nokey'))[0]?.edit).toBeUndefined()
    expect((await must('select * from t.adults'))[0]?.edit).toBeUndefined()

    const done = await pg.apply?.('', {
      object: 't.users',
      ops: [
        { op: 'update', key: { id: '1' }, values: { age: '32', tags: '{"x": true}' } },
        { op: 'insert', values: { name: 'fay', age: '40' } },
        { op: 'delete', key: { id: '2' } },
      ],
    })
    expect(done?.message).toBe('updated 1, inserted 1, deleted 1')
    const rows = (await must("select age, tags::text from t.users where id = 1 or name = 'fay' order by id"))[0]?.rows
    expect(rows).toEqual([
      ['32', '{"x": true}'],
      ['40', null],
    ])

    await expect(
      pg.apply?.('', {
        object: 't.users',
        ops: [
          { op: 'update', key: { id: '1' }, values: { age: '99' } },
          { op: 'delete', key: { id: '12345' } },
        ],
      }),
    ).rejects.toThrow(/matched 0 rows instead of 1/)
    expect((await must('select age from t.users where id = 1'))[0]?.rows[0]?.[0]).toBe('32')
  })

  it('explain analyze rolls back', async () => {
    const res = await pg.explain('', 'delete from t.users', true)
    expect(res[0]?.error).toBeUndefined()
    expect(res[0]?.rows.length).toBeGreaterThan(0)
    expect((await must('select count(*) from t.users'))[0]?.rows[0]?.[0]).not.toBe('0')
  })

  it('cancels a running statement', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 300)
    const start = Date.now()
    const res = await pg.query('', 'select pg_sleep(10)', 10, ctrl.signal)
    expect(res[0]?.error).toMatch(/cancel/)
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('refuses writes on a read-only connection', async () => {
    const ro = await openPostgres(url, true)
    try {
      const res = await ro.query('', 'select count(*) from t.users; delete from t.users', 10)
      expect(res[0]?.error).toBeUndefined()
      expect(res[1]?.error).toMatch(/read-only/)
    } finally {
      await ro.close()
    }
  })
})
