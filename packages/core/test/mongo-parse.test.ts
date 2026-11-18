import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { display, extJSON, extValue } from '../src/drivers/mongo.ts'
import { parseMongo } from '../src/drivers/mongo-parse.ts'
import { indexModel } from '../src/transfer/mongo.ts'

const one = (q: string) => {
  const stmts = parseMongo(q)
  expect(stmts).toHaveLength(1)
  return stmts[0] as (typeof stmts)[number]
}

describe('parseMongo', () => {
  it('parses a chain of calls and keeps key order', () => {
    const st = one(`db.users.find({ age: { $gt: 30 }, 'name': "Ann" }, {_id: 0}).sort({name: 1, age: -1}).limit(5)`)
    expect(st.coll).toBe('users')
    expect(st.calls.map((c) => c.name)).toEqual(['find', 'sort', 'limit'])
    expect(st.calls[0]?.args[0]).toEqual({ age: { $gt: new Int32(30) }, name: 'Ann' })
    expect(Object.keys(st.calls[1]?.args[0] as object)).toEqual(['name', 'age'])
    expect(st.calls[2]?.args[0]).toEqual(new Int32(5))
    expect(st.text).toBe(
      `db.users.find({ age: { $gt: 30 }, 'name': "Ann" }, {_id: 0}).sort({name: 1, age: -1}).limit(5)`,
    )
  })

  it('splits statements and finds the collection and database', () => {
    const script = `
      show collections
      use shop;
      // comment between statements
      db.getCollection("order items").countDocuments({})
      db.getSiblingDB('logs').events.find()
      db.runCommand({ ping: 1 })
      db.a.b.find() /* dotted collection */
      db["x.y"].find(); db.getSiblingDB("z").getCollection("w").find()
    `
    const got = parseMongo(script).map((s) => [s.kind, s.arg, s.db, s.coll].join('|'))
    expect(got).toEqual([
      'show|collections||',
      'use|shop||',
      'call|||order items',
      'call||logs|events',
      'call|||',
      'call|||a.b',
      'call|||x.y',
      'call||z|w',
    ])
    expect(parseMongo(script)[2]?.text).toBe('db.getCollection("order items").countDocuments({})')
  })

  it('reads values with the same BSON types as slimdb', () => {
    const st = one(`db.c.insertOne({
      id: ObjectId("65a1b2c3d4e5f60718293a4b"),
      at: ISODate("2026-01-31T10:00:00Z"),
      day: new Date("2026-01-31"),
      big: NumberLong("9007199254740993"),
      int: NumberInt(7),
      dbl: Double(2),
      dec: NumberDecimal("1.10"),
      uuid: UUID("0e3f2a3e-8a7b-4c1d-9e2f-3a4b5c6d7e8f"),
      f: 1.5, neg: -2, exp: 1e3, large: 3000000000, huge: 1e30, nul: null, undef: undefined, yes: true,
      inf: -Infinity, nan: NaN,
      list: [1, 'two', [3],],
      re: /^ab[/]c/i,
      esc: "line\\nnext \\"q\\" é",
      tpl: \`plain\`,
      "quoted key": 1, $dollar: 1, 12: 'num key',
    })`)
    const doc = st.calls[0]?.args[0] as Map<string, unknown>
    // An integer key written after other keys makes it a Map, so the order stays.
    expect(doc).toBeInstanceOf(Map)
    expect([...doc.keys()].at(-1)).toBe('12')
    expect(doc.get('id')).toEqual(ObjectId.createFromHexString('65a1b2c3d4e5f60718293a4b'))
    expect(doc.get('at')).toEqual(new Date('2026-01-31T10:00:00Z'))
    expect(doc.get('day')).toEqual(new Date('2026-01-31T00:00:00Z'))
    expect(doc.get('big')).toEqual(Long.fromString('9007199254740993'))
    expect(doc.get('int')).toEqual(new Int32(7))
    expect(doc.get('dbl')).toEqual(new Double(2))
    expect(doc.get('dec')).toBeInstanceOf(Decimal128)
    expect((doc.get('dec') as Decimal128).toString()).toBe('1.10')
    expect((doc.get('uuid') as Binary).sub_type).toBe(Binary.SUBTYPE_UUID)
    expect(doc.get('f')).toEqual(new Double(1.5))
    expect(doc.get('neg')).toEqual(new Int32(-2))
    expect(doc.get('exp')).toEqual(new Double(1000))
    expect(doc.get('large')).toEqual(Long.fromNumber(3000000000))
    expect(doc.get('huge')).toEqual(new Double(1e30))
    expect(doc.get('nul')).toBeNull()
    expect(doc.get('undef')).toBeNull()
    expect(doc.get('yes')).toBe(true)
    expect(doc.get('inf')).toEqual(new Double(Number.NEGATIVE_INFINITY))
    expect((doc.get('nan') as Double).value).toBeNaN()
    expect(doc.get('list')).toEqual([new Int32(1), 'two', [new Int32(3)]])
    expect(doc.get('re')).toEqual(new BSONRegExp('^ab[/]c', 'i'))
    expect(doc.get('esc')).toBe('line\nnext "q" é')
    expect(doc.get('tpl')).toBe('plain')
    expect(doc.get('quoted key')).toEqual(new Int32(1))
    expect(doc.get('$dollar')).toEqual(new Int32(1))
  })

  it('keeps int32 bounds like Go', () => {
    const args = one('db.c.find(2147483647, -2147483648, 2147483648, -2147483649)').calls[0]?.args
    expect(args).toEqual([
      new Int32(2147483647),
      new Int32(-2147483648),
      Long.fromNumber(2147483648),
      Long.fromNumber(-2147483649),
    ])
  })

  it('parses a pipeline with aggregate stages as separate arguments', () => {
    const st = one('db.c.aggregate({ $match: {} }, { $group: { _id: "$k", n: { $sum: 1 } } })')
    expect(st.calls[0]?.args).toHaveLength(2)
  })

  it.each([
    'select * from users',
    'db.users',
    'db.users.find({a: })',
    'db.users.find({a: 1}',
    'db.users.find({a: "open})',
    'db.users.find({a: someVar})',
    'db.users.find().limit',
    'db.users.find({a})',
    'db.users.find({...x})',
    'db.users.find({a: 1 + 2})',
    'db.users.find({a: function() {}})',
    `db.users.find({a: \`x\${1}\`})`,
    'db.users.find({a: process.exit()})',
    'db.users.find({a: eval("1")})',
    'db.users.find()()',
    'db.users?.find()',
    'db.users["find"]()',
    'show',
    'use\nshop',
    'db.c.find({a: ObjectId("nothex")})',
    'db.c.find({a: ISODate("yesterday")})',
    'db.c.find({a: NumberInt("99999999999")})',
  ])('rejects %s', (q) => {
    expect(() => parseMongo(q)).toThrow(/^line \d+ col \d+: /)
  })

  it('reports line and column', () => {
    expect(() => parseMongo('show dbs\ndb.users.find({a: })')).toThrow(/^line 2 col 19: Unexpected token/)
    expect(() => parseMongo('db.users.find({a: someVar})')).toThrow(
      'line 1 col 26: unknown identifier "someVar" (quote strings, e.g. "someVar")',
    )
    expect(() => parseMongo('select * from users')).toThrow(
      'line 1 col 7: expected db.<collection>.<method>(...), show or use',
    )
  })

  it('returns nothing for comments and semicolons only', () => {
    expect(parseMongo(' ; // nothing\n /* here */ ;')).toEqual([])
  })
})

describe('extended JSON', () => {
  it('reads numbers with the type their text shows', () => {
    expect(extValue('1')).toEqual(new Int32(1))
    expect(extValue('1.0')).toEqual(new Double(1))
    expect(extValue('9007199254740993')).toEqual(Long.fromString('9007199254740993'))
    expect(extValue('{"a": [2.5, "x"]}')).toEqual({ a: [new Double(2.5), 'x'] })
    expect(extValue('{"$oid": "65a1b2c3d4e5f60718293a4b"}')).toEqual(
      ObjectId.createFromHexString('65a1b2c3d4e5f60718293a4b'),
    )
    expect(extValue('{"$date": "2026-01-01T00:00:00Z"}')).toEqual(new Date('2026-01-01T00:00:00Z'))
    expect(extValue('{"$timestamp": {"t": 1, "i": 2}}')).toEqual(new Timestamp({ t: 1, i: 2 }))
    expect(extValue(null)).toBeNull()
    expect(() => extValue('{nope')).toThrow('{nope is not valid JSON')
    expect(() => extValue(5)).toThrow('must be sent as Extended JSON text')
  })

  it('writes relaxed Extended JSON that reads back with the same types', () => {
    const doc = {
      _id: ObjectId.createFromHexString('65a1b2c3d4e5f60718293a4b'),
      i: new Int32(3),
      d: new Double(2),
      l: Long.fromString('9007199254740993'),
      at: new Date('2026-01-01T00:00:00Z'),
      n: [null, true, 'x'],
    }
    const text = extJSON(doc)
    expect(text).toBe(
      '{"_id":{"$oid":"65a1b2c3d4e5f60718293a4b"},"i":3,"d":2.0,"l":9007199254740993,"at":{"$date":"2026-01-01T00:00:00Z"},"n":[null,true,"x"]}',
    )
    expect(extValue(text)).toEqual(doc)
  })

  it('shows values for the grid', () => {
    expect(display(ObjectId.createFromHexString('65a1b2c3d4e5f60718293a4b'))).toBe(
      'ObjectId("65a1b2c3d4e5f60718293a4b")',
    )
    expect(display(new Date('2026-01-01T10:00:00.500Z'))).toBe('2026-01-01T10:00:00.5Z')
    expect(display(new Int32(4))).toBe(4)
    expect(display(new Double(Number.POSITIVE_INFINITY))).toBe('+Inf')
    expect(display(Long.fromString('9007199254740993'))).toBe('9007199254740993')
    expect(display({ a: new Int32(1) })).toBe('{"a":1}')
  })
})

describe('indexModel', () => {
  it('skips the _id index and keeps the known options', () => {
    expect(indexModel({ v: 2, key: { _id: 1 }, name: '_id_' })).toBeUndefined()
    expect(
      indexModel({ v: 2, key: { name: 1 }, name: 'n', unique: true, expireAfterSeconds: new Int32(60), hidden: true }),
    ).toEqual({ keys: { name: 1 }, options: { name: 'n', unique: true, expireAfterSeconds: 60 } })
  })
})
