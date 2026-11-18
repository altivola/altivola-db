// A parser for the mongosh forms the MongoDB driver runs:
//
//   show dbs | show collections | use <db>
//   db.<collection>.<method>(args...).<method>(args...)
//   db.getCollection("name").<method>(...)
//   db.getSiblingDB("db").<collection>.<method>(...)
//   db["name.with.dots"].<method>(...)
//   db.<method>(args...)                  (database-level, e.g. runCommand)
//
// acorn turns each statement into a syntax tree, and the tree is walked with
// a strict allow list of literals and helpers. Nothing is ever evaluated: AI
// agents send queries too, so this must stay a parser, not a JavaScript engine.

import { type Expression, parseExpressionAt, type SpreadElement } from 'acorn'
import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb'

/** A parsed argument: null, string, boolean, a BSON value, an array, or a document (a plain object, or a Map when key order needs it). */
export type MongoValue = unknown

export type MongoCall = { name: string; args: MongoValue[] }

export type MongoStmt = {
  /** The statement's source text. */
  text: string
  kind: 'show' | 'use' | 'call'
  /** The word after show or use. */
  arg: string
  /** Set by getSiblingDB; empty means the current database. */
  db: string
  /** Empty for database-level calls. */
  coll: string
  calls: MongoCall[]
}

export class MongoParseError extends Error {}

/** The line and column (both from 1) of offset in s, counting characters like the Go parser did. */
function position(s: string, offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (const c of s.slice(0, offset)) {
    if (c === '\n') {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { line, col }
}

function fail(s: string, offset: number, msg: string): never {
  const { line, col } = position(s, offset)
  throw new MongoParseError(`line ${line} col ${col}: ${msg}`)
}

const spaceRE = /\s/u
const identRE = /[\p{L}_$][\p{L}\p{Nd}_$]*/uy

/** Skips white space and comments, and semicolons too when semicolons is set. */
function skip(s: string, i: number, semicolons: boolean): number {
  while (i < s.length) {
    const c = s[i] as string
    if (spaceRE.test(c) || (semicolons && c === ';')) {
      i++
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
    } else {
      break
    }
  }
  return i
}

export function parseMongo(script: string): MongoStmt[] {
  const out: MongoStmt[] = []
  let i = 0
  for (;;) {
    i = skip(script, i, true)
    if (i >= script.length) return out
    const start = i
    identRE.lastIndex = i
    const word = identRE.exec(script)?.[0] ?? ''
    let st: MongoStmt
    if (word === 'show' || word === 'use') {
      i += word.length
      while (script[i] === ' ' || script[i] === '\t') i++
      const argStart = i
      while (i < script.length && !spaceRE.test(script[i] as string) && script[i] !== ';') i++
      const arg = script.slice(argStart, i)
      if (!arg) fail(script, i, `${word} needs an argument`)
      st = { text: '', kind: word, arg, db: '', coll: '', calls: [] }
    } else if (word === 'db') {
      let node: Expression
      try {
        node = parseExpressionAt(script, start, { ecmaVersion: 'latest' })
      } catch (e) {
        throw syntaxError(script, e)
      }
      st = chain(script, node)
      i = node.end
    } else {
      fail(script, start + word.length, 'expected db.<collection>.<method>(...), show or use')
    }
    st.text = script.slice(start, i).trim()
    out.push(st)
  }
}

function syntaxError(s: string, e: unknown): Error {
  if (e instanceof SyntaxError && typeof (e as { pos?: unknown }).pos === 'number') {
    const msg = e.message.replace(/\s*\(\d+:\d+\)$/, '')
    const { line, col } = position(s, (e as unknown as { pos: number }).pos)
    return new MongoParseError(`line ${line} col ${col}: ${msg}`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

type Step =
  | { kind: 'prop'; name: string; at: number }
  | { kind: 'index'; node: Expression; at: number }
  | { kind: 'call'; args: Array<Expression | SpreadElement>; at: number }

/** Flattens a member and call chain into steps from the root, and checks the root is db. */
function steps(s: string, node: Expression | { type: string; start: number; end: number }, out: Step[]) {
  const n = node as Expression
  switch (n.type) {
    case 'Identifier':
      if (n.name !== 'db') fail(s, n.start, 'expected db.<collection>.<method>(...), show or use')
      return
    case 'MemberExpression':
      if (n.optional) fail(s, n.start, 'optional chaining (?.) is not supported')
      steps(s, n.object, out)
      if (n.computed) {
        out.push({ kind: 'index', node: n.property as Expression, at: n.property.start })
      } else if (n.property.type === 'Identifier') {
        out.push({ kind: 'prop', name: n.property.name, at: n.property.start })
      } else {
        fail(s, n.property.start, "expected a name after '.'")
      }
      return
    case 'CallExpression':
      if (n.optional) fail(s, n.start, 'optional chaining (?.) is not supported')
      steps(s, n.callee, out)
      out.push({ kind: 'call', args: n.arguments, at: n.end })
      return
  }
  fail(s, n.start, 'expected a method call such as .find()')
}

function chain(s: string, node: Expression): MongoStmt {
  const st: MongoStmt = { text: '', kind: 'call', arg: '', db: '', coll: '', calls: [] }
  const list: Step[] = []
  steps(s, node, list)
  let path: string[] = []
  for (let k = 0; k < list.length; k++) {
    const step = list[k] as Step
    const last = st.calls[st.calls.length - 1]
    if (step.kind === 'index') {
      const name = value(s, step.node)
      if (typeof name !== 'string') fail(s, step.at, 'collection name in [ ] must be a string')
      if (last) fail(s, step.at, `expected a method call after ${last.name}()`)
      if (list[k + 1]?.kind === 'call') fail(s, step.at, 'expected a method call such as .find()')
      path.push(name)
      continue
    }
    if (step.kind === 'call') {
      // A call is handled together with the name before it.
      if (list[k - 1]?.kind !== 'prop') fail(s, step.at, 'expected a method call such as .find()')
      continue
    }
    const next = list[k + 1]
    if (next?.kind !== 'call') {
      if (last) fail(s, step.at, `expected a method call after ${last.name}()`)
      path.push(step.name)
      continue
    }
    const args = next.args.map((a) => value(s, a))
    const name = step.name
    // Navigation helpers that pick the collection or database.
    if (!last && !path.length && (name === 'getCollection' || name === 'getSiblingDB')) {
      const arg = firstString(args)
      if (arg === undefined) fail(s, next.at, `${name} needs a string argument`)
      if (name === 'getCollection') path = [arg]
      else st.db = arg
      continue
    }
    if (!last) st.coll = path.join('.')
    st.calls.push({ name, args })
  }
  if (!st.calls.length) fail(s, node.end, 'expected a method call such as .find()')
  return st
}

/** The single string argument, if that is what args holds. */
export function firstString(args: MongoValue[]): string | undefined {
  return args.length === 1 && typeof args[0] === 'string' ? args[0] : undefined
}

// Integer keys such as "2" jump ahead of other keys in a plain JavaScript
// object, so such documents become a Map to keep the order as written.
const indexKeyRE = /^(?:0|[1-9]\d{0,9})$/
const isIndexKey = (k: string) => indexKeyRE.test(k) && Number(k) < 2 ** 32 - 1

function makeDoc(entries: Array<[string, MongoValue]>): MongoValue {
  const obj: Record<string, MongoValue> = {}
  for (const [k, v] of entries) obj[k] = v
  const written = [...new Set(entries.map(([k]) => k))]
  if (written.some(isIndexKey) && Object.keys(obj).join('\0') !== written.join('\0')) return new Map(entries)
  return obj
}

/** Turns a literal into a BSON value. Anything outside the allow list is an error. */
function value(s: string, node: Expression | SpreadElement): MongoValue {
  switch (node.type) {
    case 'ObjectExpression': {
      const entries: Array<[string, MongoValue]> = []
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.computed) fail(s, p.start, 'expected a key')
        if (p.shorthand) fail(s, p.end, "expected ':'")
        let key: string
        if (p.key.type === 'Identifier') key = p.key.name
        else if (p.key.type === 'Literal' && typeof p.key.value === 'string') key = p.key.value
        else if (p.key.type === 'Literal' && typeof p.key.value === 'number' && /^\d+$/.test(p.key.raw ?? ''))
          key = p.key.raw as string
        else fail(s, p.key.start, 'expected a key')
        entries.push([key, value(s, p.value)])
      }
      return makeDoc(entries)
    }
    case 'ArrayExpression':
      return node.elements.map((e) => {
        if (!e) fail(s, node.start, 'empty array slots are not supported')
        return value(s, e)
      })
    case 'Literal':
      if (node.regex) {
        try {
          return new BSONRegExp(node.regex.pattern, node.regex.flags)
        } catch (e) {
          fail(s, node.start, e instanceof Error ? e.message : String(e))
        }
      }
      if (node.bigint !== undefined) return numberValue(s, node.start, node.bigint, false)
      if (typeof node.value === 'number') return numberValue(s, node.start, node.raw ?? String(node.value), false)
      if (typeof node.value === 'string' || typeof node.value === 'boolean' || node.value === null) return node.value
      break
    case 'TemplateLiteral':
      if (node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? ''
      fail(s, node.start, 'template strings cannot hold placeholders')
      break
    case 'Identifier':
      switch (node.name) {
        case 'undefined':
          return null
        case 'Infinity':
          return new Double(Number.POSITIVE_INFINITY)
        case 'NaN':
          return new Double(Number.NaN)
      }
      fail(s, node.end, `unknown identifier "${node.name}" (quote strings, e.g. "${node.name}")`)
      break
    case 'UnaryExpression': {
      const a = node.argument
      if (node.operator === '-' || node.operator === '+') {
        const neg = node.operator === '-'
        if (a.type === 'Literal' && typeof a.value === 'number')
          return numberValue(s, node.start, a.raw ?? String(a.value), neg)
        if (a.type === 'Literal' && a.bigint !== undefined) return numberValue(s, node.start, a.bigint, neg)
        if (a.type === 'Identifier' && a.name === 'Infinity')
          return new Double(neg ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY)
      }
      break
    }
    case 'CallExpression':
    case 'NewExpression': {
      if (node.callee.type !== 'Identifier') break
      const name = node.callee.name
      const args = node.arguments.map((a) => value(s, a))
      try {
        return typeHelper(name, args)
      } catch (e) {
        fail(s, node.end, e instanceof Error ? e.message : String(e))
      }
      break
    }
    case 'SpreadElement':
      fail(s, node.start, 'spread (...) is not supported')
  }
  const text = s.slice(node.start, node.end)
  fail(s, node.start, `unexpected ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)}`)
}

const INT32_MIN = -(2n ** 31n)
const INT32_MAX = 2n ** 31n - 1n
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * A number literal: integers that fit in int32 become Int32, larger ones Long
 * (or a Double past int64), and anything with a fraction or exponent Double.
 */
function numberValue(s: string, at: number, raw: string, negative: boolean): MongoValue {
  const text = raw.replaceAll('_', '')
  const sign = negative ? -1 : 1
  if (/^(?:\d+|0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+)n?$/.test(text)) {
    let n: bigint
    try {
      n = BigInt(text.replace(/n$/, ''))
    } catch {
      fail(s, at, `bad number "${raw}"`)
    }
    if (negative) n = -n
    if (n >= INT32_MIN && n <= INT32_MAX) return new Int32(Number(n))
    if (n >= INT64_MIN && n <= INT64_MAX) return Long.fromBigInt(n)
    return new Double(sign * Number(text.replace(/n$/, '')))
  }
  const f = Number(text)
  if (Number.isNaN(f)) fail(s, at, `bad number "${raw}"`)
  return new Double(sign * f)
}

/** fmt.Sprint-like text for a helper argument. */
function sprint(v: MongoValue): string {
  if (typeof v === 'string') return v
  if (v instanceof Int32 || v instanceof Double) return String(v.value)
  if (v instanceof Long) return v.toString()
  return String(v)
}

const datePatterns: Array<[RegExp, (s: string) => string]> = [
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, (s) => s.replace(/(\.\d{3})\d+/, '$1')],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, (s) => `${s}Z`],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, (s) => `${s}:00Z`],
  [/^\d{4}-\d{2}-\d{2}$/, (s) => `${s}T00:00:00Z`],
]

function parseDate(s: string): Date | undefined {
  for (const [re, fix] of datePatterns) {
    if (!re.test(s)) continue
    const d = new Date(fix(s))
    // Reject days a month does not have, e.g. 2026-02-30.
    const [y, m, day] = s.slice(0, 10).split('-').map(Number) as [number, number, number]
    const check = new Date(Date.UTC(y, m - 1, day))
    if (Number.isNaN(d.getTime()) || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return undefined
    return d
  }
  return undefined
}

/** The mongosh type helpers, e.g. ObjectId("..."), ISODate("..."), NumberLong("..."). */
export function typeHelper(name: string, args: MongoValue[]): MongoValue {
  const arg = () => {
    if (args.length !== 1) throw new Error(`${name} takes one argument`)
    return sprint(args[0])
  }
  switch (name) {
    case 'ObjectId':
    case 'ObjectID': {
      if (!args.length) return new ObjectId()
      const s = arg()
      if (!/^[\da-fA-F]{24}$/.test(s)) throw new Error('the provided hex string is not a valid ObjectID')
      return ObjectId.createFromHexString(s)
    }
    case 'ISODate':
    case 'Date': {
      if (!args.length) return new Date()
      const s = arg()
      const d = parseDate(s)
      if (!d) throw new Error(`cannot read date "${s}", use e.g. 2026-01-31T10:00:00Z`)
      return d
    }
    case 'NumberLong':
    case 'Long': {
      const s = arg()
      if (!/^[+-]?\d+$/.test(s)) throw new Error(`bad number "${s}"`)
      const n = BigInt(s)
      if (n < INT64_MIN || n > INT64_MAX) throw new Error(`number "${s}" is out of range`)
      return Long.fromBigInt(n)
    }
    case 'NumberInt':
    case 'Int32': {
      const s = arg()
      if (!/^[+-]?\d+$/.test(s)) throw new Error(`bad number "${s}"`)
      const n = BigInt(s)
      if (n < INT32_MIN || n > INT32_MAX) throw new Error(`number "${s}" is out of range`)
      return new Int32(Number(n))
    }
    case 'Double': {
      const s = arg().trim()
      const f = /^[+-]?(?:inf|infinity)$/i.test(s) ? (s.startsWith('-') ? -1 : 1) * Number.POSITIVE_INFINITY : Number(s)
      if (s === '' || (Number.isNaN(f) && s.toLowerCase() !== 'nan')) throw new Error(`bad number "${s}"`)
      return new Double(f)
    }
    case 'NumberDecimal':
    case 'Decimal128': {
      const s = arg()
      try {
        return Decimal128.fromString(s)
      } catch {
        throw new Error(`bad decimal "${s}"`)
      }
    }
    case 'UUID': {
      const s = arg()
      const hex = s.replaceAll('-', '')
      if (!/^[\da-fA-F]{32}$/.test(hex)) throw new Error(`bad UUID "${s}"`)
      return new Binary(Buffer.from(hex, 'hex'), Binary.SUBTYPE_UUID)
    }
  }
  throw new Error(`unknown function ${name}()`)
}
