// The MongoDB driver. Queries are written in mongosh syntax (see mongo-parse.ts).

import {
  BSON,
  type Collection,
  type Db,
  type Document,
  type Double,
  type Int32,
  type Long,
  MongoClient,
  type MongoClientOptions,
  ObjectId,
} from 'mongodb'
import { editSummary } from '../edit.ts'
import {
  type Cell,
  type Changes,
  type Driver,
  type EditInfo,
  type EditOp,
  emptyResult,
  errorMessage,
  ReadOnlyError,
  type Result,
  type TreeNode,
} from '../types.ts'
import { firstString, type MongoCall, type MongoStmt, type MongoValue, parseMongo } from './mongo-parse.ts'

export const appName = 'altivola-db'

/** Read options that keep BSON types (Int32, Double, Long, regex) instead of turning them into JavaScript numbers. */
export const typedRead = { promoteValues: false, bsonRegExp: true } as const

/** Opens a client with the app name set. The URL is checked here, before any network call. */
export function mongoClient(url: string, extra: MongoClientOptions = {}): MongoClient {
  return new MongoClient(url, { appName, ...extra })
}

/** The database named in a MongoDB URL, or '' when it has none. */
export function urlDatabase(url: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/[^/?#]*(?:\/([^?#]*))?/i.exec(url)
  if (!m) throw new Error('Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"')
  return decodeURIComponent(m[1] ?? '')
}

// Write methods are refused on read-only connections. runCommand is included
// because it can do anything.
const writeMethods = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'createIndex',
  'dropIndex',
  'drop',
  'createCollection',
  'dropDatabase',
  'runCommand',
])

export async function openMongo(url: string, readOnly: boolean): Promise<Driver> {
  const client = mongoClient(url)
  const defaultDB = urlDatabase(url) || 'test'
  try {
    await client.db('admin').command({ ping: 1 }, { timeoutMS: 10_000 })
  } catch (e) {
    await client.close().catch(() => {})
    throw e
  }
  return new MongoDriver(client, defaultDB, readOnly)
}

class MongoDriver implements Driver {
  constructor(
    private client: MongoClient,
    private defaultDB: string,
    private readOnly: boolean,
  ) {}

  close() {
    return this.client.close()
  }

  private dbName(name: string | undefined) {
    return name || this.defaultDB
  }

  // Lists every database the user can see, falling back to the database
  // from the URL when listDatabases is not allowed.
  async tree(): Promise<TreeNode[]> {
    let names: string[]
    try {
      const res = await this.client.db('admin').admin().listDatabases({ nameOnly: true })
      names = res.databases.map((d) => d.name)
    } catch {
      names = [this.defaultDB]
    }
    names.sort(compare)
    const out: TreeNode[] = []
    for (const name of names) {
      const specs = await this.client.db(name).listCollections({}, { nameOnly: false }).toArray()
      specs.sort((a, b) => compare(a.name, b.name))
      out.push({
        name,
        kind: 'database',
        database: name,
        children: specs.map((s) => ({
          name: s.name,
          kind: s.type === 'view' ? 'view' : 'collection',
          object: s.name,
          database: name,
        })),
      })
    }
    return out
  }

  // Infers the top-level fields from a sample of 200 documents and lists the indexes.
  async describe(database: string, object: string): Promise<Result[]> {
    const coll = this.client.db(this.dbName(database)).collection(object)
    const docs = await coll.aggregate([{ $sample: { size: 200 } }], typedRead).toArray()
    const fields = new Map<string, { types: Set<string>; seen: number }>()
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        let f = fields.get(k)
        if (!f) {
          f = { types: new Set(), seen: 0 }
          fields.set(k, f)
        }
        f.seen++
        f.types.add(bsonTypeName(v))
      }
    }
    const rows: Cell[][] = [...fields].map(([name, f]) => [
      name,
      [...f.types].sort(compare).join(' | '),
      `${roundHalfEven((100 * f.seen) / docs.length)}%`,
    ])
    const fieldsResult = emptyResult({
      title: 'Fields',
      columns: [{ name: 'field' }, { name: 'types' }, { name: 'present' }],
      rows,
      message: `inferred from a sample of ${docs.length} documents`,
    })
    const idx = await coll.listIndexes(typedRead).toArray()
    const indexes = docsResult(idx, 0)
    indexes.title = 'Indexes'
    return [fieldsResult, indexes]
  }

  async query(database: string, q: string, limit: number, signal?: AbortSignal): Promise<Result[]> {
    let stmts: MongoStmt[]
    try {
      stmts = parseMongo(q)
    } catch (e) {
      return [emptyResult({ statement: q, error: errorMessage(e) })]
    }
    if (!stmts.length) throw new Error('nothing to run')
    let current = this.dbName(database)
    const out: Result[] = []
    for (const st of stmts) {
      const start = performance.now()
      let r: Result
      if (signal?.aborted) {
        r = emptyResult({ error: 'canceled' })
      } else if (st.kind === 'use') {
        current = st.arg
        r = emptyResult({ message: `switched to db ${current}` })
      } else {
        try {
          r = await this.run(current, st, limit, signal)
        } catch (e) {
          r = emptyResult({ error: errorMessage(e) })
        }
      }
      r.statement = st.text
      r.ms = Math.round(performance.now() - start)
      out.push(r)
      if (r.error) break
    }
    return out
  }

  private async run(current: string, st: MongoStmt, limit: number, signal?: AbortSignal): Promise<Result> {
    if (st.kind === 'show') return this.show(current, st.arg)
    const db = this.client.db(this.dbName(st.db || current))
    const call = st.calls[0] as MongoCall
    if (this.readOnly && (writeMethods.has(call.name) || (call.name === 'aggregate' && pipelineWrites(call.args)))) {
      throw new Error(`${call.name} is not allowed on a read-only connection`)
    }
    if (!st.coll) {
      if (st.calls.length > 1) throw new Error(`${call.name}() cannot be chained`)
      return dbCall(db, call, signal)
    }
    return collCall(db, db.collection(st.coll), call, st.calls.slice(1), limit, signal)
  }

  private async show(current: string, what: string): Promise<Result> {
    switch (what) {
      case 'dbs':
      case 'databases': {
        const res = await this.client.db('admin').admin().listDatabases()
        return emptyResult({
          columns: [{ name: 'name' }, { name: 'sizeOnDisk' }, { name: 'empty' }],
          rows: res.databases.map((d) => [d.name, display(d.sizeOnDisk ?? null), display(d.empty ?? null)]),
        })
      }
      case 'collections':
      case 'tables':
        return namesResult(this.client.db(current))
    }
    throw new Error(`show ${what} is not supported, use show dbs or show collections`)
  }

  // Explains the first statement, which must be a find, aggregate or count.
  async explain(database: string, q: string, analyze: boolean): Promise<Result[]> {
    const stmts = parseMongo(q)
    const st = stmts[0]
    if (st?.kind !== 'call' || !st.coll) {
      throw new Error('explain needs db.<collection>.find(), aggregate() or countDocuments()')
    }
    const call = st.calls[0] as MongoCall
    let inner: Document
    switch (call.name) {
      case 'find':
      case 'findOne':
        inner = { find: st.coll, filter: docArg(call.args, 0, false) }
        for (const mod of st.calls.slice(1)) {
          switch (mod.name) {
            case 'sort':
            case 'limit':
            case 'skip':
            case 'hint':
              inner[mod.name] = argAt(mod.args, 0)
              break
            case 'projection':
            case 'project':
              inner.projection = argAt(mod.args, 0)
          }
        }
        break
      case 'aggregate':
        inner = { aggregate: st.coll, pipeline: pipelineArg(call.args), cursor: {} }
        break
      case 'countDocuments':
      case 'count':
        inner = { count: st.coll, query: docArg(call.args, 0, false) }
        break
      default:
        throw new Error(`cannot explain ${call.name}()`)
    }
    const verbosity = analyze ? 'executionStats' : 'queryPlanner'
    const db = this.client.db(this.dbName(st.db || database))
    const start = performance.now()
    let r: Result
    try {
      r = await command(db, { explain: inner, verbosity })
    } catch (e) {
      r = emptyResult({ error: errorMessage(e) })
    }
    r.title = 'Plan'
    r.statement = st.text
    r.ms = Math.round(performance.now() - start)
    return [r]
  }

  // Writes grid edits. MongoDB has no transactions on a standalone server, so
  // the changes run in order and stop at the first failure; the error says
  // how many went in.
  async apply(database: string, c: Changes): Promise<Result> {
    if (this.readOnly) throw new ReadOnlyError()
    if (!c.object) throw new Error('no collection given')
    const start = performance.now()
    const coll = this.client.db(this.dbName(database)).collection(c.object)
    let done = 0
    const fail = (i: number, op: EditOp, e: unknown) => {
      const msg = `change ${i + 1} (${op.op}): ${errorMessage(e)}`
      return new Error(done > 0 ? `${msg}; the ${done} changes before it were saved` : msg)
    }
    for (const [i, op] of c.ops.entries()) {
      try {
        let filter: Document = {}
        if (op.op !== 'insert') {
          const keys = Object.keys(op.key ?? {})
          if (keys.length !== 1 || keys[0] !== '_id') throw new Error('a document to change needs its _id')
          filter = { _id: extValue(op.key?._id ?? null) }
        }
        const values = extDoc(op.values ?? {})
        switch (op.op) {
          case 'update': {
            if (!Object.keys(values).length) throw new Error('an update needs at least one value')
            const res = await coll.updateOne(filter, { $set: values })
            if (res.matchedCount !== 1) throw new Error('the document is gone')
            break
          }
          case 'delete': {
            const res = await coll.deleteOne(filter)
            if (res.deletedCount !== 1) throw new Error('the document is gone')
            break
          }
          case 'insert':
            await coll.insertOne(values)
            break
          default:
            throw new Error(`unknown edit ${JSON.stringify((op as EditOp).op)}`)
        }
      } catch (e) {
        throw fail(i, op, e)
      }
      done++
    }
    return emptyResult({ message: editSummary(c), affected: done, ms: Math.round(performance.now() - start) })
  }
}

// --- database and collection calls ---

async function namesResult(db: Db): Promise<Result> {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(compare)
  return emptyResult({ columns: [{ name: 'name' }], rows: names.map((n) => [n]) })
}

async function dbCall(db: Db, call: MongoCall, signal?: AbortSignal): Promise<Result> {
  switch (call.name) {
    case 'runCommand':
      return command(db, docArg(call.args, 0, true), signal)
    case 'stats':
      return command(db, { dbStats: 1 }, signal)
    case 'getCollectionNames':
      return namesResult(db)
    case 'createCollection': {
      const name = firstString(call.args)
      if (name === undefined) throw new Error('createCollection needs a name')
      await db.createCollection(name)
      return emptyResult({ message: `created ${name}` })
    }
    case 'dropDatabase':
      await db.dropDatabase()
      return emptyResult({ message: `dropped ${db.databaseName}` })
  }
  throw new Error(
    `db.${call.name}() is not supported; supported: runCommand, stats, getCollectionNames, createCollection, dropDatabase`,
  )
}

async function command(db: Db, cmd: Document, signal?: AbortSignal): Promise<Result> {
  const doc = await db.command(cmd, { ...typedRead, ...(signal ? { signal } : {}) })
  return docsResult([doc], 0)
}

async function collCall(
  db: Db,
  coll: Collection,
  call: MongoCall,
  mods: MongoCall[],
  limit: number,
  signal?: AbortSignal,
): Promise<Result> {
  const a = call.args
  const sig = signal ? { signal } : {}
  switch (call.name) {
    case 'find':
    case 'findOne':
      return find(coll, call, mods, limit, signal)
    case 'aggregate': {
      const cur = coll.aggregate(pipelineArg(a), { ...typedRead, ...sig, batchSize: batchSize(limit) })
      return readCursor(cur, limit)
    }
    case 'countDocuments':
    case 'count':
      return valueResult('count', await coll.countDocuments(docArg(a, 0, false), sig))
    case 'estimatedDocumentCount':
      return valueResult('count', await coll.estimatedDocumentCount())
    case 'distinct': {
      const field = argAt(a, 0)
      if (typeof field !== 'string') throw new Error('distinct needs a field name')
      const filter = docArg(a, 1, false)
      // The distinct command keeps BSON types, which coll.distinct() would not.
      const res = await db.command(
        { distinct: coll.collectionName, key: field, query: filter },
        { ...typedRead, ...sig },
      )
      const values = Array.isArray(res.values) ? res.values : []
      return emptyResult({ columns: [{ name: field }], rows: values.map((v: unknown) => [display(v)]) })
    }
    case 'insertOne': {
      const doc = withId(docArg(a, 0, true))
      const res = await coll.insertOne(doc)
      return { ...valueResult('insertedId', display(res.insertedId)), affected: 1, message: 'inserted 1 document' }
    }
    case 'insertMany': {
      const docs = argAt(a, 0)
      if (!Array.isArray(docs) || !docs.every(isDoc)) throw new Error('insertMany needs an array of documents')
      const res = await coll.insertMany(docs.map(withId))
      return emptyResult({ affected: res.insertedCount, message: `inserted ${res.insertedCount} documents` })
    }
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
      return update(coll, call)
    case 'deleteOne':
    case 'deleteMany': {
      const filter = docArg(a, 0, true)
      const res = call.name === 'deleteOne' ? await coll.deleteOne(filter) : await coll.deleteMany(filter)
      return emptyResult({ affected: res.deletedCount, message: `deleted ${res.deletedCount} documents` })
    }
    case 'createIndex':
      return createIndex(coll, a)
    case 'dropIndex': {
      const name = firstString(a)
      if (name === undefined) throw new Error('dropIndex needs the index name')
      await coll.dropIndex(name)
      return emptyResult({ message: `dropped index ${name}` })
    }
    case 'getIndexes':
      return readCursor(coll.listIndexes(typedRead), 0)
    case 'drop':
      await coll.drop()
      return emptyResult({ message: `dropped ${coll.collectionName}` })
  }
  throw new Error(
    `${call.name}() is not supported; supported: find, findOne, aggregate, countDocuments, ` +
      'estimatedDocumentCount, distinct, insertOne, insertMany, updateOne, updateMany, replaceOne, ' +
      'deleteOne, deleteMany, createIndex, dropIndex, getIndexes, drop',
  )
}

// find applies cursor modifiers such as .sort().limit().skip(), and never
// reads more than limit documents (plus one, to tell whether there were more).
async function find(
  coll: Collection,
  call: MongoCall,
  mods: MongoCall[],
  limit: number,
  signal?: AbortSignal,
): Promise<Result> {
  const filter = docArg(call.args, 0, false)
  const opts: Document = { ...typedRead, ...(signal ? { signal } : {}) }
  const projection = docArg(call.args, 1, false)
  if (docKeys(projection).length) opts.projection = projection
  let userLimit = call.name === 'findOne' ? 1 : 0
  for (const mod of mods) {
    switch (mod.name) {
      case 'sort':
        opts.sort = docArg(mod.args, 0, true)
        break
      case 'projection':
      case 'project':
        opts.projection = docArg(mod.args, 0, true)
        break
      case 'limit':
        userLimit = toNumber(argAt(mod.args, 0))
        break
      case 'skip':
        opts.skip = toNumber(argAt(mod.args, 0))
        break
      case 'hint':
        opts.hint = argAt(mod.args, 0)
        break
      case 'count':
        return valueResult('count', await coll.countDocuments(filter, signal ? { signal } : {}))
      case 'toArray':
      case 'pretty':
        break
      default:
        throw new Error(`.${mod.name}() is not supported after find; use sort, limit, skip, projection, hint or count`)
    }
  }
  let effective = limit
  if (userLimit > 0 && (limit <= 0 || userLimit <= limit)) {
    opts.limit = userLimit
    effective = 0 // the server already stops at the user's limit
  } else if (limit > 0) {
    opts.limit = limit + 1
  }
  opts.batchSize = batchSize(Math.max(effective, userLimit))
  const r = await readCursor(coll.find(filter, opts), effective)
  const edit = mongoEditInfo(coll, r)
  if (edit) r.edit = edit
  return r
}

async function update(coll: Collection, call: MongoCall): Promise<Result> {
  const filter = docArg(call.args, 0, true)
  const upd = argAt(call.args, 1)
  if (upd === null) throw new Error(`${call.name} needs a filter and an update`)
  const opt = docArg(call.args, 2, false)
  const upsert = get(opt, 'upsert') === true
  const res =
    call.name === 'updateOne'
      ? await coll.updateOne(filter, upd as Document, { upsert })
      : call.name === 'updateMany'
        ? await coll.updateMany(filter, upd as Document, { upsert })
        : await coll.replaceOne(filter, upd as Document, { upsert })
  let msg = `matched ${res.matchedCount}, modified ${res.modifiedCount}`
  if (res.upsertedCount > 0) msg += `, upserted ${display(res.upsertedId)}`
  return emptyResult({ affected: res.modifiedCount + res.upsertedCount, message: msg })
}

async function createIndex(coll: Collection, a: MongoValue[]): Promise<Result> {
  const keys = docArg(a, 0, true)
  const opt = docArg(a, 1, false)
  const io: Document = {}
  const name = get(opt, 'name')
  if (typeof name === 'string') io.name = name
  if (get(opt, 'unique') === true) io.unique = true
  if (get(opt, 'sparse') === true) io.sparse = true
  const ttl = get(opt, 'expireAfterSeconds')
  if (ttl !== undefined && ttl !== null) io.expireAfterSeconds = toNumber(ttl)
  const made = await coll.createIndex(keys, io)
  return emptyResult({ message: `created index ${made}` })
}

// --- grid edits ---

/** Makes find results editable when every document has an _id. */
function mongoEditInfo(coll: Collection, r: Result): EditInfo | undefined {
  const idx = r.columns.findIndex((c) => c.name === '_id')
  if (idx < 0 || !r.rows.length) return undefined
  if (r.rows.some((row) => row[idx] === null || row[idx] === undefined)) return undefined
  return { object: coll.collectionName, database: coll.dbName, key: ['_id'], columns: r.columns.map((c) => c.name) }
}

const INT32_MIN = -(2n ** 31n)
const INT32_MAX = 2n ** 31n - 1n
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Canonical Extended JSON for one JSON number, typed by how it was written: 1 is an int, 1.0 a double. */
function typedNumber(src: string): Document {
  if (/^-?\d+$/.test(src)) {
    const n = BigInt(src)
    if (n >= INT32_MIN && n <= INT32_MAX) return { $numberInt: src }
    if (n >= INT64_MIN && n <= INT64_MAX) return { $numberLong: src }
  }
  return { $numberDouble: String(Number(src)) }
}

/** Undoes typedNumber where Extended JSON wants a plain number, as in {"$timestamp": {"t": 1, "i": 2}}. */
function plainNumber(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['$numberInt', '$numberLong', '$numberDouble']) {
      if (typeof o[k] === 'string' && Object.keys(o).length === 1) return Number(o[k])
    }
  }
  return v
}

/**
 * Parses one value written as relaxed Extended JSON, e.g. 42, "text",
 * {"$oid": "..."} or {"$date": "2026-01-01T00:00:00Z"}. Numbers get the BSON
 * type their text shows, like the Go driver: 1 is an int32, 1.0 a double.
 */
export function extValue(v: Cell): unknown {
  if (v === null) return null
  if (typeof v !== 'string') throw new Error(`value ${v} must be sent as Extended JSON text`)
  try {
    const tree = JSON.parse(`{"v":${v}}`, (_key, val: unknown, ctx?: { source?: string }) => {
      if (typeof val === 'number') return typedNumber(ctx?.source ?? String(val))
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const o = val as Record<string, unknown>
        if (o.$timestamp && typeof o.$timestamp === 'object') {
          const t = o.$timestamp as Record<string, unknown>
          t.t = plainNumber(t.t)
          t.i = plainNumber(t.i)
        }
      }
      return val
    })
    return BSON.EJSON.parse(JSON.stringify(tree), { relaxed: false }).v
  } catch (e) {
    throw new Error(`${v} is not valid JSON: ${errorMessage(e)}`)
  }
}

function extDoc(m: Record<string, Cell>): Document {
  const d: Document = {}
  for (const k of Object.keys(m).sort()) {
    try {
      d[k] = extValue(m[k] ?? null)
    } catch (e) {
      throw new Error(`${k}: ${errorMessage(e)}`)
    }
  }
  return d
}

// --- results ---

type Cursor = AsyncIterable<Document> & { close(): Promise<void> }

/** Reads up to limit documents (0 means all) and closes the cursor. */
async function readCursor(cur: Cursor, limit: number): Promise<Result> {
  const docs: Document[] = []
  try {
    for await (const d of cur) {
      docs.push(d)
      if (limit > 0 && docs.length > limit) break
    }
  } finally {
    await cur.close()
  }
  return docsResult(docs, limit)
}

/**
 * Turns documents into a table. Columns are the union of the top-level keys
 * in first-seen order; nested values are shown as JSON.
 */
export function docsResult(docs: Document[], limit: number): Result {
  const r = emptyResult()
  if (limit > 0 && docs.length > limit) {
    docs = docs.slice(0, limit)
    r.truncated = true
  }
  const col = new Map<string, number>()
  for (const d of docs) {
    for (const k of docKeys(d)) {
      if (!col.has(k)) {
        col.set(k, r.columns.length)
        r.columns.push({ name: k })
      }
    }
  }
  r.docs = []
  for (const d of docs) {
    const row: Cell[] = new Array(r.columns.length).fill(null)
    for (const [k, v] of docEntries(d)) row[col.get(k) as number] = display(v)
    r.rows.push(row)
    r.docs.push(extJSON(d))
  }
  r.message = `${docs.length} documents`
  return r
}

function valueResult(name: string, v: Cell): Result {
  return emptyResult({ columns: [{ name }], rows: [[v]] })
}

const bsonKind = (v: unknown): string | undefined =>
  v instanceof BSON.BSONValue ? (v as unknown as { _bsontype: string })._bsontype : undefined

/** Converts a BSON value into something JSON can carry and a grid can show. */
export function display(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : goFloat(v)
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? extJSON(v) : rfc3339(v)
  switch (bsonKind(v)) {
    case 'Int32':
      return (v as Int32).value
    case 'Double': {
      const f = (v as Double).value
      return Number.isFinite(f) ? f : goFloat(f)
    }
    case 'Long': {
      const n = (v as Long).toBigInt()
      return Number.isSafeInteger(Number(n)) ? Number(n) : n.toString()
    }
    case 'ObjectId':
      return `ObjectId("${(v as ObjectId).toHexString()}")`
  }
  return extJSON(v)
}

/** Infinity and NaN as Go prints them. */
const goFloat = (f: number) => (Number.isNaN(f) ? 'NaN' : f > 0 ? '+Inf' : '-Inf')

/** A date as RFC 3339 in UTC with no trailing zeros in the fraction, e.g. 2026-01-01T10:00:00.5Z. */
function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.(\d*?)0*Z$/, (_m, frac: string) => (frac ? `.${frac}Z` : 'Z'))
}

/** A double the way relaxed Extended JSON prints it: 2.0 keeps its .0 so it reads back as a double. */
function doubleJSON(f: number): string {
  if (!Number.isFinite(f))
    return JSON.stringify({ $numberDouble: Number.isNaN(f) ? 'NaN' : f > 0 ? 'Infinity' : '-Infinity' })
  const s = Object.is(f, -0) ? '-0' : String(f)
  return /[.e]/.test(s) ? s : `${s}.0`
}

/** Renders any BSON value as relaxed Extended JSON, keeping the key order of documents. */
export function extJSON(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : doubleJSON(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return `[${v.map(extJSON).join(',')}]`
  switch (bsonKind(v)) {
    case 'Int32':
      return String((v as Int32).value)
    case 'Double':
      return doubleJSON((v as Double).value)
    case 'Long':
      return (v as Long).toString()
  }
  if (isDoc(v))
    return `{${docEntries(v as Document)
      .map(([k, x]) => `${JSON.stringify(k)}:${extJSON(x)}`)
      .join(',')}}`
  return BSON.EJSON.stringify(v as Document, { relaxed: true })
}

/** The type names describe shows, the same as MongoDB's $type aliases. */
export function bsonTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (v instanceof Date) return 'date'
  if (Array.isArray(v)) return 'array'
  const kind = bsonKind(v)
  const names: Record<string, string> = {
    Int32: 'int',
    Long: 'long',
    Double: 'double',
    ObjectId: 'objectId',
    Decimal128: 'decimal',
    Binary: 'binData',
    BSONRegExp: 'regex',
    Timestamp: 'timestamp',
    Code: 'javascript',
    BSONSymbol: 'symbol',
    MinKey: 'minKey',
    MaxKey: 'maxKey',
    DBRef: 'object',
  }
  if (kind) return names[kind] ?? kind
  if (isDoc(v)) return 'object'
  return typeof v
}

// --- argument helpers ---

/** A document: a plain object or a Map, but not a BSON value, date or array. */
export function isDoc(v: unknown): boolean {
  if (v instanceof Map) return true
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  if (v instanceof Date || v instanceof BSON.BSONValue || ArrayBuffer.isView(v) || v instanceof RegExp) return false
  return true
}

export function docEntries(d: unknown): Array<[string, unknown]> {
  if (d instanceof Map) return [...d]
  return Object.entries(d as Document)
}

const docKeys = (d: unknown) => docEntries(d).map(([k]) => k)

export function get(d: unknown, key: string): unknown {
  if (d instanceof Map) return d.get(key)
  return d && Object.hasOwn(d as Document, key) ? (d as Document)[key] : undefined
}

function argAt(args: MongoValue[], i: number): MongoValue {
  return i < args.length ? args[i] : null
}

/** Returns argument i as a document. A missing optional argument is an empty document. */
function docArg(args: MongoValue[], i: number, required: boolean): Document {
  const v = argAt(args, i)
  if (isDoc(v)) return v as Document
  if (v === null || v === undefined) {
    if (required) throw new Error(`argument ${i + 1} must be a document`)
    return {}
  }
  throw new Error(`argument ${i + 1} must be a document, got ${bsonTypeName(v)}`)
}

/** Accepts aggregate([stage, ...]) and aggregate(stage, stage, ...). */
function pipelineArg(args: MongoValue[]): Document[] {
  if (args.length === 1 && Array.isArray(args[0])) return args[0] as Document[]
  for (const [i, a] of args.entries()) {
    if (!isDoc(a)) throw new Error(`aggregate stage ${i + 1} must be a document`)
  }
  return args as Document[]
}

function pipelineWrites(args: MongoValue[]): boolean {
  let p: Document[]
  try {
    p = pipelineArg(args)
  } catch {
    return false
  }
  return p.some((stage) => {
    const first = isDoc(stage) ? docKeys(stage)[0] : undefined
    return first === '$out' || first === '$merge'
  })
}

/** Any number-like value as a JavaScript number; anything else is 0. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  switch (bsonKind(v)) {
    case 'Int32':
      return (v as Int32).value
    case 'Double':
      return Math.trunc((v as Double).value)
    case 'Long':
      return (v as Long).toNumber()
  }
  return 0
}

/**
 * A document written with integer keys out of order is a Map (see
 * mongo-parse.ts). The driver cannot see an _id inside a Map, so one is
 * added here, both as the first entry and as a property the driver reads back.
 */
function withId(doc: unknown): Document {
  if (!(doc instanceof Map)) return doc as Document
  let id = doc.get('_id')
  let out = doc
  if (id === undefined || id === null) {
    id = new ObjectId()
    out = new Map<string, unknown>([['_id', id], ...[...doc].filter(([k]) => k !== '_id')])
  }
  Object.defineProperty(out, '_id', { value: id, enumerable: false, configurable: true, writable: true })
  return out as unknown as Document
}

function batchSize(limit: number): number {
  if (limit <= 0 || limit >= 1000) return 1000
  return limit + 1
}

/** Byte order comparison, like Go's sort.Strings. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Rounds like Go's %.0f: halves go to the even neighbor. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
