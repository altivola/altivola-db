import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Double, Int32, Long, MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMongo } from '../src/drivers/mongo.ts'
import { copyMongo, dumpMongo, restoreMongo } from '../src/transfer/mongo.ts'
import type { Driver, Result } from '../src/types.ts'

let container: StartedMongoDBContainer
let base: string
let m: Driver
let client: MongoClient
const dbName = 'altivola_test'
const url = (db = '') => `${base}/${db}?directConnection=true`

async function run(d: Driver, database: string, q: string, limit = 0): Promise<Result[]> {
  const res = await d.query(database, q, limit)
  for (const r of res) if (r.error) throw new Error(`statement ${r.statement} failed: ${r.error}`)
  return res
}

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:7').start()
  base = container.getConnectionString()
  client = new MongoClient(url())
  m = await openMongo(url(), false)
  await run(
    m,
    dbName,
    `
    db.users.insertMany([
      { name: "ann", age: 31, tags: ["a", "b"], at: ISODate("2026-01-01T00:00:00Z") },
      { name: "bob", age: 25 },
      { name: "cy", age: 12, address: { city: "Jakarta" } },
    ])
    db.users.createIndex({ name: 1 }, { unique: true, name: "name_unique" })
    db.createCollection("empty")`,
  )
  await client.db(dbName).command({ create: 'adults', viewOn: 'users', pipeline: [{ $match: { age: { $gte: 18 } } }] })
}, 120_000)

afterAll(async () => {
  await m?.close()
  await client?.close()
  await container?.stop()
})

describe('mongo driver', () => {
  it('finds with modifiers and returns docs as relaxed Extended JSON', async () => {
    const [r] = await run(m, dbName, `db.users.find({ age: { $gte: 18 } }, { _id: 0 }).sort({ age: -1 })`, 10)
    expect(r?.rows).toHaveLength(2)
    expect(r?.columns[0]?.name).toBe('name')
    expect(r?.rows[0]?.[0]).toBe('ann')
    expect(r?.docs?.[0]).toContain('"tags":["a","b"]')
    expect(r?.docs?.[0]).toContain('"at":{"$date":"2026-01-01T00:00:00Z"}')
    // No _id, so the grid cannot write it back.
    expect(r?.edit).toBeUndefined()
  })

  it('marks truncation by the limit, but not by the user limit', async () => {
    let [r] = await run(m, dbName, 'db.users.find()', 2)
    expect(r?.rows).toHaveLength(2)
    expect(r?.truncated).toBe(true)
    ;[r] = await run(m, dbName, 'db.users.find().limit(2)', 100)
    expect(r?.rows).toHaveLength(2)
    expect(r?.truncated).toBe(false)
    ;[r] = await run(m, dbName, 'db.users.find()', 3)
    expect(r?.truncated).toBe(false)
    ;[r] = await run(m, dbName, 'db.users.findOne({ name: "bob" })', 10)
    expect(r?.rows).toHaveLength(1)
    expect(r?.edit).toMatchObject({ object: 'users', database: dbName, key: ['_id'] })
    ;[r] = await run(m, dbName, 'db.users.find().skip(1).count()', 10)
    expect(r?.rows).toEqual([[3]])
  })

  it('runs aggregate, count and distinct', async () => {
    const res = await run(
      m,
      dbName,
      `db.users.aggregate([{ $group: { _id: null, total: { $sum: "$age" } } }])
       db.users.countDocuments({ age: { $lt: 30 } })
       db.users.distinct("name")
       db.users.estimatedDocumentCount()`,
      10,
    )
    expect(res[0]?.rows[0]?.[1]).toBe(68)
    expect(res[1]?.rows).toEqual([[2]])
    expect(res[2]?.rows).toEqual([['ann'], ['bob'], ['cy']])
    expect(res[3]?.rows).toEqual([[3]])
  })

  it('inserts, updates and deletes', async () => {
    const res = await run(
      m,
      dbName,
      `db.users.updateOne({ name: "bob" }, { $set: { age: 26 } })
       db.users.updateOne({ name: "zed" }, { $set: { age: 1 } }, { upsert: true })
       db.users.deleteMany({ name: "zed" })
       db.things.insertOne({ n: 1, f: 1.5, d: Double(2), l: NumberLong(5), "2": "two", "1": "one" })`,
      10,
    )
    expect(res.map((r) => r.affected)).toEqual([1, 1, 1, 1])
    expect(res[1]?.message).toMatch(/^matched 0, modified 0, upserted ObjectId\("[0-9a-f]{24}"\)$/)
    expect(res[3]?.message).toBe('inserted 1 document')
    const doc = await client.db(dbName).collection('things').findOne({}, { promoteValues: false })
    expect(doc?.n).toEqual(new Int32(1))
    expect(doc?.f).toEqual(new Double(1.5))
    expect(doc?.d).toEqual(new Double(2))
    expect(doc?.l).toEqual(Long.fromNumber(5))
    // The id the result shows is the one stored, also for a document kept in a Map.
    expect(res[3]?.rows[0]?.[0]).toBe(`ObjectId("${doc?._id.toHexString()}")`)
    // Integer keys keep the order they were written in, which a plain object would change.
    const raw = Buffer.from(
      (await client.db(dbName).collection('things').findOne({}, { raw: true })) as unknown as Uint8Array,
    )
    expect(raw.indexOf(Buffer.from('\x022\x00', 'latin1'))).toBeLessThan(
      raw.indexOf(Buffer.from('\x021\x00', 'latin1')),
    )
  })

  it('switches databases with use, shows collections, and stops at the first error', async () => {
    const res = await m.query('', `use ${dbName}\nshow collections\ndb.users.badMethod()\ndb.users.find()`, 10)
    expect(res).toHaveLength(3)
    expect(res[0]?.message).toBe(`switched to db ${dbName}`)
    expect(res[1]?.rows.map((r) => r[0])).toEqual(['adults', 'empty', 'system.views', 'things', 'users'])
    expect(res[2]?.error).toMatch(/^badMethod\(\) is not supported/)
    const dbs = await run(m, '', 'show dbs')
    expect(dbs[0]?.rows.map((r) => r[0])).toContain(dbName)
  })

  it('returns syntax errors as a result', async () => {
    const res = await m.query(dbName, 'db.users.find({a: })', 10)
    expect(res).toHaveLength(1)
    expect(res[0]?.error).toMatch(/^line 1 col \d+:/)
    expect(res[0]?.statement).toBe('db.users.find({a: })')
    await expect(m.query(dbName, '// nothing', 10)).rejects.toThrow('nothing to run')
  })

  it('does not start the next statement after an abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await m.query(dbName, 'db.users.find()\ndb.users.find()', 10, ac.signal)
    expect(res).toHaveLength(1)
    expect(res[0]?.error).toBe('canceled')
  })

  it('runs database calls', async () => {
    const res = await run(m, dbName, 'db.runCommand({ ping: 1 })\ndb.getCollectionNames()\ndb.stats()')
    expect(res[0]?.columns[0]?.name).toBe('ok')
    expect(res[1]?.rows).toContainEqual(['users'])
    expect(res[2]?.columns.map((c) => c.name)).toContain('collections')
    const bad = await m.query(dbName, 'db.users.find().nope()', 10)
    expect(bad[0]?.error).toBe('.nope() is not supported after find; use sort, limit, skip, projection, hint or count')
  })

  it('lists the tree and describes a collection', async () => {
    const nodes = await m.tree()
    const node = nodes.find((n) => n.name === dbName)
    expect(node?.children?.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'view:adults',
      'collection:empty',
      'collection:system.views',
      'collection:things',
      'collection:users',
    ])
    const res = await m.describe(dbName, 'users')
    const fields = res[0]
    expect(fields?.title).toBe('Fields')
    expect(fields?.rows.find((r) => r[0] === 'age')).toEqual(['age', 'int', '100%'])
    expect(fields?.rows.find((r) => r[0] === 'tags')).toEqual(['tags', 'array', '33%'])
    expect(fields?.message).toBe('inferred from a sample of 3 documents')
    expect(res[1]?.title).toBe('Indexes')
    expect(res[1]?.rows).toHaveLength(2)
  })

  it('explains through the explain command', async () => {
    const res = await m.explain(dbName, 'db.users.find({ name: "ann" }).limit(1)', true)
    expect(res[0]?.error).toBeUndefined()
    expect(res[0]?.title).toBe('Plan')
    expect(res[0]?.docs?.[0]).toContain('name_unique')
    expect(res[0]?.docs?.[0]).toContain('executionStats')
    const agg = await m.explain(dbName, 'db.users.aggregate([{ $match: { age: 1 } }])', false)
    expect(agg[0]?.error).toBeUndefined()
    await expect(m.explain(dbName, 'show dbs', false)).rejects.toThrow('explain needs')
  })

  it('refuses writes on a read-only connection', async () => {
    const ro = await openMongo(url(), true)
    try {
      for (const q of [
        'db.users.deleteMany({})',
        'db.users.aggregate([{ $match: {} }, { $out: "copy" }])',
        'db.runCommand({ drop: "users" })',
      ]) {
        const res = await ro.query(dbName, q, 10)
        expect(res[0]?.error).toMatch(/is not allowed on a read-only connection$/)
      }
      await run(ro, dbName, 'db.users.find()', 10)
      await expect(ro.apply?.(dbName, { object: 'users', ops: [] })).rejects.toThrow('read-only')
    } finally {
      await ro.close()
    }
  })

  it('applies grid edits and stops at the first failure', async () => {
    await run(m, dbName, 'db.edits.insertMany([{ _id: 1, v: "a" }, { _id: 2, v: "b" }])')
    const ok = await m.apply?.(dbName, {
      object: 'edits',
      ops: [
        { op: 'update', key: { _id: '1' }, values: { v: '"A"', n: '2.0' } },
        { op: 'delete', key: { _id: '2' } },
        { op: 'insert', values: { _id: '3', at: '{"$date": "2026-01-01T00:00:00Z"}' } },
      ],
    })
    expect(ok).toMatchObject({ message: 'updated 1, inserted 1, deleted 1', affected: 3 })
    const docs = await client
      .db(dbName)
      .collection('edits')
      .find({}, { promoteValues: false })
      .sort({ _id: 1 })
      .toArray()
    expect(docs).toEqual([
      { _id: new Int32(1), v: 'A', n: new Double(2) },
      { _id: new Int32(3), at: new Date('2026-01-01T00:00:00Z') },
    ])
    await expect(
      m.apply?.(dbName, {
        object: 'edits',
        ops: [
          { op: 'update', key: { _id: '1' }, values: { v: '"B"' } },
          { op: 'update', key: { _id: '99' }, values: { v: '"C"' } },
        ],
      }),
    ).rejects.toThrow('change 2 (update): the document is gone; the 1 changes before it were saved')
    await expect(
      m.apply?.(dbName, { object: 'edits', ops: [{ op: 'update', key: { v: '"A"' }, values: { v: '1' } }] }),
    ).rejects.toThrow('change 1 (update): a document to change needs its _id')
  })
})

describe('mongo transfer', () => {
  it('dumps and restores a database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'altivola-mongo-'))
    try {
      await run(
        m,
        'dumpsrc',
        'db.items.insertMany([{ k: 1, d: Double(1) }, { k: 2, big: NumberLong("9007199254740993") }])',
      )
      await run(m, 'dumpsrc', 'db.items.createIndex({ k: 1 }, { unique: true, name: "k_unique" })')
      await client.db('dumpsrc').command({ create: 'v', viewOn: 'items', pipeline: [] })
      const path = join(dir, 'x.mongo.gz')
      const out = createWriteStream(path)
      const lines: string[] = []
      await dumpMongo(url('dumpsrc'), { mode: 'all' }, out, (l) => lines.push(l))
      out.end()
      await once(out, 'close')
      expect(lines).toContain('items: 2 documents, 2 indexes')
      expect(lines).toContain('skipped view v: views are not dumped')

      const report = await restoreMongo(url('dumpdst'), { mode: 'all' }, path, (l) => lines.push(l))
      expect(report.warnings).toEqual([])
      expect(lines).toContain('importing a dump of dumpsrc (all) into dumpdst')
      const coll = client.db('dumpdst').collection('items')
      const docs = await coll
        .find({}, { promoteValues: false, projection: { _id: 0 } })
        .sort({ k: 1 })
        .toArray()
      expect(docs).toEqual([
        { k: new Int32(1), d: new Double(1) },
        { k: new Int32(2), big: Long.fromString('9007199254740993') },
      ])
      const names = (await coll.listIndexes().toArray()).map((i) => i.name)
      expect(names).toEqual(['_id_', 'k_unique'])

      // Data mode replaces the documents.
      await run(m, 'dumpdst', 'db.items.insertOne({ k: 3 })')
      await restoreMongo(url('dumpdst'), { mode: 'data' }, path, () => {})
      expect(await coll.countDocuments()).toBe(2)

      // The database comes from the dump header when the URL has none.
      await restoreMongo(url(), { mode: 'schema' }, path, () => {})
      expect(await client.db('dumpsrc').collection('items').countDocuments()).toBe(0)

      const bad = join(dir, 'bad.gz')
      await writeFile(bad, 'plain text')
      await expect(restoreMongo(url('dumpdst'), { mode: 'all' }, bad, () => {})).rejects.toThrow(
        'not an altivola-db MongoDB dump',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads slimdb dumps', async () => {
    const { BSON } = await import('mongodb')
    const { gzipSync } = await import('node:zlib')
    const dir = await mkdtemp(join(tmpdir(), 'altivola-mongo-'))
    try {
      const path = join(dir, 'old.mongo.gz')
      const parts = [
        BSON.serialize({ magic: 'slimdb-mongo-dump', version: 1, database: 'old', mode: 'all' }),
        BSON.serialize({ collection: 'c', indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }] }),
        BSON.serialize({ doc: { _id: 1, x: 'y' } }),
      ]
      await writeFile(path, gzipSync(Buffer.concat(parts)))
      await restoreMongo(url('fromslimdb'), { mode: 'all' }, path, () => {})
      expect(await client.db('fromslimdb').collection('c').find().toArray()).toEqual([{ _id: 1, x: 'y' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('copies a database into another one', async () => {
    await run(
      m,
      'copysrc',
      `db.a.insertMany([{ _id: 1, n: 1 }, { _id: 2, n: 2 }])
       db.a.createIndex({ n: 1 }, { name: "n_1", sparse: true })
       db.b.insertOne({ _id: "x" })`,
    )
    await client.db('copysrc').command({ create: 'va', viewOn: 'a', pipeline: [] })
    // The target holds a unique index that refuses one source document in data mode.
    await run(
      m,
      'copydst',
      'db.a.insertOne({ _id: 9, n: 9 })\ndb.a.createIndex({ n: 1 }, { unique: true, name: "n_u" })',
    )

    const lines: string[] = []
    let report = await copyMongo(url('copysrc'), url('copydst'), { mode: 'all' }, (l) => lines.push(l))
    expect(report.warnings).toEqual(['skipped view va: views are not copied'])
    expect(lines).toContain('a: 2 documents, 1 indexes')
    expect(await client.db('copydst').collection('a').countDocuments()).toBe(2)
    expect((await client.db('copydst').collection('a').listIndexes().toArray()).map((i) => i.name)).toEqual([
      '_id_',
      'n_1',
    ])

    await run(m, 'copysrc', 'db.a.insertOne({ _id: 3, n: 3 })')
    report = await copyMongo(url('copysrc'), url('copydst'), { mode: 'data' }, () => {})
    expect(await client.db('copydst').collection('a').countDocuments()).toBe(3)

    report = await copyMongo(url('copysrc'), url('copyschema'), { mode: 'schema' }, () => {})
    expect(await client.db('copyschema').collection('a').countDocuments()).toBe(0)
    expect((await client.db('copyschema').listCollections().toArray()).map((c) => c.name).sort()).toEqual(['a', 'b'])

    await expect(copyMongo(url(), url('x'), { mode: 'all' }, () => {})).rejects.toThrow(
      'put the source database in its URL',
    )
  })

  it('turns documents the target refuses into warnings', async () => {
    await run(m, 'refsrc', 'db.a.insertMany([{ _id: 1, n: 1 }, { _id: 2, n: 1 }])')
    await run(m, 'refdst', 'db.a.createIndex({ n: 1 }, { unique: true })')
    const report = await copyMongo(url('refsrc'), url('refdst'), { mode: 'data' }, () => {})
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatch(/^a: 1 documents skipped \(E11000 duplicate key/)
    expect(await client.db('refdst').collection('a').countDocuments()).toBe(1)
  })

  it('stops a copy when the signal aborts', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(copyMongo(url('copysrc'), url('aborted'), { mode: 'all' }, () => {}, ac.signal)).rejects.toThrow()
  })
})
