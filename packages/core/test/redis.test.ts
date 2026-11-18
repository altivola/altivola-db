import { describe, expect, it } from 'vitest'
import { type Reply, shapeRedis, splitCommand } from '../src/drivers/redis.ts'
import { emptyResult } from '../src/types.ts'

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted arguments', () => {
    expect(splitCommand(`set "a b" 'it\\'s' "line\\nnext" plain`)).toEqual([
      'set',
      'a b',
      "it's",
      'line\nnext',
      'plain',
    ])
  })

  it('handles tabs, empty quotes and escapes only in double quotes', () => {
    expect(splitCommand('get\t""  x')).toEqual(['get', '', 'x'])
    expect(splitCommand(`echo 'a\\nb' "q\\"t"`)).toEqual(['echo', 'a\\nb', 'q"t'])
    expect(splitCommand('echo "tab\\there" "cr\\r"')).toEqual(['echo', 'tab\there', 'cr\r'])
  })

  it('joins a quoted part with the text next to it', () => {
    expect(splitCommand(`set key"name" v`)).toEqual(['set', 'keyname', 'v'])
  })

  it('refuses unbalanced quotes and empty lines', () => {
    expect(() => splitCommand('get "open')).toThrow('unbalanced quotes in "get \\"open"')
    expect(() => splitCommand(`get 'open`)).toThrow('unbalanced quotes')
    expect(() => splitCommand('   ')).toThrow('empty command')
  })
})

function shape(cmd: string, v: Reply, limit = 0) {
  const res = emptyResult()
  shapeRedis(cmd, v, limit, res)
  return { columns: res.columns.map((c) => c.name), rows: res.rows, truncated: res.truncated, message: res.message }
}

describe('shapeRedis', () => {
  it('turns a map into field/value rows sorted by field', () => {
    const m = new Map<Reply, Reply>([
      ['name', 'ann'],
      ['city', 'Bandung'],
      ['age', '30'],
    ])
    expect(shape('hgetall', m)).toEqual({
      columns: ['field', 'value'],
      rows: [
        ['age', '30'],
        ['city', 'Bandung'],
        ['name', 'ann'],
      ],
      truncated: false,
      message: undefined,
    })
    expect(shape('hgetall', m, 2)).toMatchObject({
      rows: [
        ['age', '30'],
        ['city', 'Bandung'],
      ],
      truncated: true,
    })
  })

  it('shows the next cursor for the SCAN family', () => {
    expect(shape('scan', ['17', ['a', 'b']])).toEqual({
      columns: ['value'],
      rows: [['a'], ['b']],
      truncated: false,
      message: 'next cursor 17 (0 means done)',
    })
    expect(shape('hscan', ['0', ['f1', 'v1', 'f2', 'v2']])).toMatchObject({
      columns: ['field', 'value'],
      rows: [
        ['f1', 'v1'],
        ['f2', 'v2'],
      ],
      message: 'next cursor 0 (0 means done)',
    })
    expect(shape('sscan', ['0', ['a', 'b', 'c']], 2)).toMatchObject({ rows: [['a'], ['b']], truncated: true })
  })

  it('puts equal-width scalar tuples in numbered columns', () => {
    expect(
      shape('zrange', [
        ['bob', 5],
        ['ann', 10.5],
      ]),
    ).toMatchObject({
      columns: ['#', 'value 1', 'value 2'],
      rows: [
        ['1', 'bob', '5'],
        ['2', 'ann', '10.5'],
      ],
    })
  })

  it('numbers a plain array and writes nested values as JSON', () => {
    expect(shape('lrange', ['a', null, ['x', 1n], new Map<Reply, Reply>([['b', 2]])])).toMatchObject({
      columns: ['#', 'value'],
      rows: [
        ['1', 'a'],
        ['2', null],
        ['3', '["x",1]'],
        ['4', '{"b":2}'],
      ],
    })
    // Tuples of different width, or with nested values, are a plain array.
    expect(shape('x', [['a'], ['b', 'c']]).columns).toEqual(['#', 'value'])
    expect(shape('x', [['a', ['b']]]).rows).toEqual([['1', '["a",["b"]]']])
    expect(shape('x', []).rows).toEqual([])
  })

  it('splits INFO into key/value and skips section headers', () => {
    const info = '# Server\r\nredis_version:8.0.0\r\nos:Linux:x86\r\n\r\n# Keyspace\r\ndb0:keys=1,expires=0\r\n'
    expect(shape('info', info)).toMatchObject({
      columns: ['key', 'value'],
      rows: [
        ['redis_version', '8.0.0'],
        ['os', 'Linux:x86'],
        ['db0', 'keys=1,expires=0'],
      ],
    })
  })

  it('writes scalars as text, and nil as null', () => {
    expect(shape('get', 'hello').rows).toEqual([['hello']])
    expect(shape('get', null).rows).toEqual([[null]])
    expect(shape('incr', '9007199254740993').rows).toEqual([['9007199254740993']])
    expect(shape('zscore', 1.5).rows).toEqual([['1.5']])
    expect(shape('zscore', Number.POSITIVE_INFINITY).rows).toEqual([['inf']])
    expect(shape('x', true).rows).toEqual([['true']])
    expect(shape('x', 12345678901234567890n).rows).toEqual([['12345678901234567890']])
    expect(shape('info', 'no colon here').rows).toEqual([])
  })
})
