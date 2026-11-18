import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRedis } from '../src/drivers/redis.ts'
import type { Driver, Result } from '../src/types.ts'

let container: StartedRedisContainer
let url: string
let r: Driver

async function run(d: Driver, database: string, q: string, limit = 0): Promise<Result[]> {
  const res = await d.query(database, q, limit)
  for (const x of res) if (x.error) throw new Error(`${x.statement}: ${x.error}`)
  return res
}

const names = (res: Result | undefined) => res?.columns.map((c) => c.name)

beforeAll(async () => {
  container = await new RedisContainer('redis:8').start()
  url = `${container.getConnectionUrl()}/0`
  r = await openRedis(url, false)
  await run(
    r,
    '1',
    `# seed data
    flushdb
    set greeting "hello world"
    hset user:1 name ann city 'Bandung'
    rpush queue a b c
    zadd board 10 ann 5 bob
    sadd tags x y
    // a stream entry
    xadd events * kind login`,
  )
}, 120_000)

afterAll(async () => {
  await r?.close()
  await container?.stop()
})

describe('query', () => {
  it('shapes replies as tables', async () => {
    const res = await run(
      r,
      '1',
      'get greeting\nhgetall user:1\nlrange queue 0 -1\nget missing\nzrange board 0 -1 withscores\nscan 0\ninfo server',
      2,
    )
    expect(res).toHaveLength(7)
    const [get, hgetall, lrange, missing, zrange, scan, info] = res
    expect(get?.rows).toEqual([['hello world']])
    expect(get?.statement).toBe('get greeting')
    expect(names(hgetall)).toEqual(['field', 'value'])
    expect(hgetall?.rows).toEqual([
      ['city', 'Bandung'],
      ['name', 'ann'],
    ])
    expect(names(lrange)).toEqual(['#', 'value'])
    expect(lrange?.rows).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ])
    expect(lrange?.truncated).toBe(true)
    expect(missing?.rows).toEqual([[null]])
    expect(names(zrange)).toEqual(['#', 'value 1', 'value 2'])
    expect(zrange?.rows).toEqual([
      ['1', 'bob', '5'],
      ['2', 'ann', '10'],
    ])
    expect(scan?.message).toMatch(/^next cursor \d+ \(0 means done\)$/)
    expect(names(scan)).toEqual(['value'])
    expect(scan?.rows).toHaveLength(2)
    expect(names(info)).toEqual(['key', 'value'])
    expect(info?.rows[0]?.[0]).toBe('redis_version')
    for (const x of res) expect(x.ms).toBeGreaterThanOrEqual(0)
  })

  it('shows integers and full ZRANGE results', async () => {
    const [incr, card, all] = await run(r, '1', 'incr counter\nzcard board\nzrange board 0 -1 withscores')
    expect(incr?.rows).toEqual([['1']])
    expect(card?.rows).toEqual([['2']])
    expect(all?.truncated).toBe(false)
    await run(r, '1', 'del counter')
  })

  it('stops at the first error', async () => {
    const res = await r.query('1', 'nosuchcommand\nget greeting', 0)
    expect(res).toHaveLength(1)
    expect(res[0]?.error).toMatch(/unknown command/)
    const bad = await r.query('1', 'get "open', 0)
    expect(bad[0]?.error).toBe('unbalanced quotes in "get \\"open"')
  })

  it('refuses commands it cannot show', async () => {
    const res = await r.query('1', 'subscribe news', 0)
    expect(res[0]?.error).toBe('subscribing is not supported here')
    expect((await r.query('1', 'multi', 0))[0]?.error).toBe('MULTI/EXEC is not supported here')
  })

  it('needs at least one command', async () => {
    await expect(r.query('1', '# only a comment\n\n// and another', 0)).rejects.toThrow('nothing to run')
  })

  it('picks the database from "N", "dbN" or the URL', async () => {
    await run(r, 'db2', 'set only2 yes')
    expect((await run(r, '2', 'get only2'))[0]?.rows).toEqual([['yes']])
    expect((await run(r, '', 'get only2'))[0]?.rows).toEqual([[null]])
    expect((await run(r, '1', 'get only2'))[0]?.rows).toEqual([[null]])
    await expect(r.query('nope', 'get x', 0)).rejects.toThrow('bad Redis database "nope", use a number such as 0')
    await expect(r.query('-1', 'get x', 0)).rejects.toThrow('bad Redis database')
    await run(r, '2', 'flushdb')
  })

  it('does not carry SELECT over to the next query', async () => {
    await run(r, '1', 'select 3')
    expect((await run(r, '1', 'get greeting'))[0]?.rows).toEqual([['hello world']])
  })

  it('stops a running command when the signal aborts', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const res = await r.query('1', 'blpop nothing 0\nget greeting', 0, ac.signal)
    expect(res).toHaveLength(1)
    expect(res[0]?.error).toBe('canceled')
    expect(await r.query('1', 'get greeting', 0, ac.signal)).toEqual([])
    expect((await run(r, '1', 'get greeting'))[0]?.rows).toEqual([['hello world']])
  })

  it('has no explain', async () => {
    const [plan] = await r.explain('1', 'get greeting', false)
    expect(plan).toMatchObject({ title: 'Plan', error: 'explain is not available for Redis' })
  })
})

describe('tree', () => {
  it('lists each database with its keys and their types', async () => {
    const nodes = await r.tree()
    const db0 = nodes.find((n) => n.name === 'db0')
    expect(db0).toMatchObject({ kind: 'database', children: [] })
    const db1 = nodes.find((n) => n.name === 'db1')
    expect(db1?.kind).toBe('database')
    expect(db1?.children?.map((k) => [k.name, k.kind])).toEqual([
      ['board', 'zset'],
      ['events', 'stream'],
      ['greeting', 'string'],
      ['queue', 'list'],
      ['tags', 'set'],
      ['user:1', 'hash'],
    ])
    for (const k of db1?.children ?? []) {
      expect(k.object).toBe(k.name)
      expect(k.database).toBe('1')
    }
    expect(nodes.map((n) => n.name)).toEqual([...nodes.map((n) => n.name)].sort())
  })

  it('caps each database at 1000 keys', async () => {
    const lines = ['flushdb']
    for (let i = 0; i < 12; i++) {
      const keys = Array.from({ length: 100 }, (_, j) => `k${i * 100 + j} v`).join(' ')
      lines.push(`mset ${keys}`)
    }
    await run(r, '4', lines.join('\n'))
    const db4 = (await r.tree()).find((n) => n.name === 'db4')
    expect(db4?.children).toHaveLength(1000)
    await run(r, '4', 'flushdb')
  })
})

describe('describe', () => {
  const props = (res: Result[]) => Object.fromEntries((res[0]?.rows ?? []).map((row) => [row[0], row[1]]))

  it('shows each type with a Key and a Value section', async () => {
    const want: Record<string, { type: string; columns: string[]; rows: number; length?: number }> = {
      greeting: { type: 'string', columns: ['value'], rows: 1 },
      'user:1': { type: 'hash', columns: ['field', 'value'], rows: 2, length: 2 },
      queue: { type: 'list', columns: ['index', 'value'], rows: 3, length: 3 },
      board: { type: 'zset', columns: ['member', 'score'], rows: 2, length: 2 },
      tags: { type: 'set', columns: ['member'], rows: 2, length: 2 },
      events: { type: 'stream', columns: ['id', 'fields'], rows: 1, length: 1 },
    }
    for (const [key, w] of Object.entries(want)) {
      const res = await r.describe('1', key)
      expect(res.map((x) => x.title)).toEqual(['Key', 'Value'])
      expect(names(res[0])).toEqual(['property', 'value'])
      const p = props(res)
      expect(p).toMatchObject({ key, type: w.type, ttl: 'no expiry' })
      expect(p.memory).toMatch(/^\d+ bytes$/)
      expect(p.length).toBe(w.length)
      expect(names(res[1]), key).toEqual(w.columns)
      expect(res[1]?.rows, key).toHaveLength(w.rows)
      expect(res[1]?.truncated).toBe(false)
    }
  })

  it('shows values in a stable order', async () => {
    expect((await r.describe('1', 'greeting'))[1]?.rows).toEqual([['hello world']])
    expect((await r.describe('1', 'queue'))[1]?.rows).toEqual([
      ['0', 'a'],
      ['1', 'b'],
      ['2', 'c'],
    ])
    expect((await r.describe('db1', 'board'))[1]?.rows).toEqual([
      ['bob', '5'],
      ['ann', '10'],
    ])
    expect((await r.describe('1', 'tags'))[1]?.rows).toEqual([['x'], ['y']])
    expect((await r.describe('1', 'user:1'))[1]?.rows).toEqual([
      ['city', 'Bandung'],
      ['name', 'ann'],
    ])
    const events = (await r.describe('1', 'events'))[1]?.rows[0]
    expect(events?.[0]).toMatch(/^\d+-\d+$/)
    expect(events?.[1]).toBe('{"kind":"login"}')
  })

  it('shows the time to live', async () => {
    await run(r, '5', 'set short v EX 3725')
    expect(props(await r.describe('5', 'short')).ttl).toBe('1h2m5s')
    await run(r, '5', 'flushdb')
  })

  it('caps long values and marks them truncated', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => `i${i}`).join(' ')
    // SSCAN COUNT is only a hint, so the set needs to be well past 1000 to come back in part.
    const members = Array.from({ length: 5000 }, (_, i) => `m${i}`).join(' ')
    const ids = Array.from({ length: 101 }, (_, i) => `xadd s ${i + 1}-0 f v`).join('\n')
    await run(r, '6', `rpush l ${items}\nsadd s2 ${members}\n${ids}`)
    const list = await r.describe('6', 'l')
    expect(list[1]?.rows).toHaveLength(1000)
    expect(list[1]?.truncated).toBe(true)
    const set = await r.describe('6', 's2')
    expect(set[1]?.rows.length).toBeLessThan(5000)
    expect(set[1]?.truncated).toBe(true)
    const stream = await r.describe('6', 's')
    expect(stream[1]?.rows).toHaveLength(100)
    expect(stream[1]?.truncated).toBe(true)
    await run(r, '6', 'flushdb')
  })

  it('says when the key is missing', async () => {
    await expect(r.describe('1', 'nope')).rejects.toThrow('key "nope" not found in db1')
  })
})

describe('read-only', () => {
  it('refuses writes and runs reads', async () => {
    const ro = await openRedis(url, true)
    try {
      expect((await run(ro, '1', 'get greeting'))[0]?.rows).toEqual([['hello world']])
      const res = await ro.query('1', 'get greeting\ndel greeting\nget greeting', 0)
      expect(res).toHaveLength(2)
      expect(res[1]?.error).toBe('this connection is read-only')
      expect((await ro.query('1', 'EVAL "return 1" 0', 0))[0]?.error).toBe('this connection is read-only')
      expect((await ro.query('1', 'eval_ro "return 1" 0', 0))[0]?.error).toBeUndefined()
    } finally {
      await ro.close()
    }
    expect((await run(r, '1', 'exists greeting'))[0]?.rows).toEqual([['1']])
  })
})

describe('openRedis', () => {
  it('fails fast when the server is not there', async () => {
    await expect(openRedis('redis://127.0.0.1:1/0', false)).rejects.toThrow()
  })
})
