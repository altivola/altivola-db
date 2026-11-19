// D1 has no container, so these tests put a real SQLite database behind a
// fake of D1's /raw endpoint: same request and reply shapes, and a batch runs
// in one transaction like D1 does.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1Target, openD1 } from '../src/drivers/d1.ts'
import { type Changes, type Driver, ReadOnlyError } from '../src/types.ts'

function apply(d: Driver, c: Changes) {
  if (!d.apply) throw new Error('no apply')
  return d.apply('', c)
}

type Stmt = { sql: string; params?: SQLInputValue[] }

function fakeD1(db: DatabaseSync, token = 'tok'): typeof fetch {
  const run = ({ sql, params = [] }: Stmt) => {
    const st = db.prepare(sql)
    st.setReturnArrays(true)
    if (st.columns().length) {
      const rows = (st.all(...params) as unknown as unknown[][]).map((r) =>
        r.map((v) => (v instanceof Uint8Array ? [...v] : v)),
      )
      return { results: { columns: st.columns().map((c) => c.name), rows }, meta: { changes: 0 }, success: true }
    }
    const { changes } = st.run(...params)
    return { results: { columns: [], rows: [] }, meta: { changes: Number(changes) }, success: true }
  }
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db1/raw')
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status })
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${token}`) {
      return reply(401, { success: false, result: null, errors: [{ code: 10000, message: 'Authentication error' }] })
    }
    const body = JSON.parse(String(init?.body)) as Stmt | { batch: Stmt[] }
    try {
      if ('batch' in body) {
        db.exec('begin')
        try {
          const out = body.batch.map(run)
          db.exec('commit')
          return reply(200, { success: true, result: out, errors: [] })
        } catch (e) {
          db.exec('rollback')
          throw e
        }
      }
      return reply(200, { success: true, result: [run(body)], errors: [] })
    } catch (e) {
      return reply(400, { success: false, result: [], errors: [{ code: 7500, message: (e as Error).message }] })
    }
  }) as typeof fetch
}

const url = 'd1://tok@acc/db1'

describe('d1Target', () => {
  it('reads the URL', () => {
    expect(d1Target('d1://a%2Fb@acc/db1')).toEqual({ token: 'a/b', account: 'acc', database: 'db1' })
    expect(() => d1Target('d1://acc/db1')).toThrow(/d1:\/\/<api token>/)
  })
})

describe('D1 driver', () => {
  let db: DatabaseSync
  let d: Driver

  beforeEach(async () => {
    db = new DatabaseSync(':memory:')
    db.exec(`create table _cf_KV (k text);
      create table ideas (id integer primary key, idea text not null, score real, raw blob);
      insert into ideas values (1, 'kasir', 1.5, x'00ff'), (2, 'nikah', null, null);`)
    d = await openD1(url, false, fakeD1(db))
  })

  it('fails to open with a bad token', async () => {
    await expect(openD1('d1://nope@acc/db1', false, fakeD1(db))).rejects.toThrow(/Authentication error.*API token/)
  })

  it('lists tables without the ones D1 keeps', async () => {
    expect(await d.tree()).toEqual([
      { name: 'main', kind: 'schema', children: [{ name: 'ideas', kind: 'table', object: '"ideas"' }] },
    ])
  })

  it('runs queries as text and marks them editable', async () => {
    const [r] = await d.query('', 'select * from ideas order by id', 1)
    expect(r?.columns.map((c) => c.name)).toEqual(['id', 'idea', 'score', 'raw'])
    expect(r?.rows).toEqual([['1', 'kasir', '1.5', '0x00FF']])
    expect(r?.truncated).toBe(true)
    expect(r?.edit).toMatchObject({ object: '"ideas"', key: ['id'] })
    const [w] = await d.query('', "update ideas set idea = 'x' where id > 0", 0)
    expect(w?.affected).toBe(2)
  })

  it('describes a table', async () => {
    const [cols] = await d.describe('', 'IDEAS')
    expect(cols?.rows[0]).toEqual(['id', 'INTEGER', 'true', null, 'true'])
  })

  it('applies grid edits in one batch', async () => {
    await apply(d, {
      object: '"ideas"',
      ops: [
        { op: 'update', key: { id: '1' }, values: { idea: 'kasir kopi' } },
        { op: 'insert', values: { id: '3', idea: 'agent' } },
      ],
    })
    expect(
      db
        .prepare('select idea from ideas order by id')
        .all()
        .map((r) => r.idea),
    ).toEqual(['kasir kopi', 'nikah', 'agent'])
  })

  it('saves nothing when an edit matches no row', async () => {
    const edits = {
      object: '"ideas"',
      ops: [
        { op: 'update' as const, key: { id: '1' }, values: { idea: 'changed' } },
        { op: 'delete' as const, key: { id: '99' } },
      ],
    }
    await expect(apply(d, edits)).rejects.toThrow(/nothing was saved/)
    expect(db.prepare('select idea from ideas where id = 1').get()?.idea).toBe('kasir')
  })

  it('blocks writes when read-only', async () => {
    const ro = await openD1(url, true, fakeD1(db))
    const [r] = await ro.query('', 'delete from ideas', 0)
    expect(r?.error).toBe(new ReadOnlyError().message)
    await expect(apply(ro, { object: '"ideas"', ops: [{ op: 'delete', key: { id: '1' } }] })).rejects.toThrow(
      ReadOnlyError,
    )
  })
})
