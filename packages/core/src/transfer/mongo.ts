// Copying, dumping and importing MongoDB databases with the driver.
//
// A dump is altivola-db's own format: a gzipped stream of BSON documents, a
// header first, then per collection a record with its indexes followed by
// one record per document. slimdb wrote the same format, so its dumps import too.

import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import {
  BSON,
  type Collection,
  type CreateIndexesOptions,
  type Db,
  type Document,
  type IndexSpecification,
  MongoBulkWriteError,
} from 'mongodb'
import { docEntries, isDoc, mongoClient, toNumber, typedRead, urlDatabase } from '../drivers/mongo.ts'
import { errorMessage } from '../types.ts'
import type { CopyOptions, CopyReport, Log } from './types.ts'

const dumpMagic = 'altivola-db-mongo-dump'
const oldDumpMagic = 'slimdb-mongo-dump'
const batchSize = 1000

const deserialize = (b: Uint8Array) => BSON.deserialize(b, typedRead) as Document

export async function copyMongo(
  src: string,
  dst: string,
  opt: CopyOptions,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  const report: CopyReport = { warnings: [] }
  const srcName = urlDatabase(src)
  if (!srcName) throw new Error('put the source database in its URL, e.g. mongodb://host:27017/shop')
  const dstName = urlDatabase(dst) || srcName
  const srcClient = mongoClient(src)
  const dstClient = mongoClient(dst)
  try {
    const srcDB = srcClient.db(srcName)
    const dstDB = dstClient.db(dstName)
    let specs: Document[]
    try {
      specs = await srcDB.listCollections({}, { nameOnly: false }).toArray()
    } catch (e) {
      throw new Error(`list source collections: ${errorMessage(e)}`)
    }
    log(`copying ${specs.length} collections from ${srcName} into ${dstName}`)
    for (const spec of specs) {
      const name = String(spec.name)
      if (name.startsWith('system.')) continue
      if (spec.type === 'view') {
        warn(report, log, `skipped view ${name}: views are not copied`)
        continue
      }
      signal?.throwIfAborted()
      try {
        await copyCollection(srcDB, dstDB, name, opt, report, log, signal)
      } catch (e) {
        if (signal?.aborted) throw e
        throw new Error(`${name}: ${errorMessage(e)}`)
      }
    }
    return report
  } finally {
    await Promise.allSettled([srcClient.close(), dstClient.close()])
  }
}

async function copyCollection(
  srcDB: Db,
  dstDB: Db,
  name: string,
  opt: CopyOptions,
  report: CopyReport,
  log: Log,
  signal?: AbortSignal,
) {
  const src = srcDB.collection(name)
  const dst = await prepare(dstDB, name, opt)
  const batch = new Batch(dst, name, report, log)
  if (opt.mode !== 'schema') {
    const cur = src.find({}, { ...typedRead, ...(signal ? { signal } : {}) })
    try {
      for await (const doc of cur) {
        await batch.add(doc, signal)
      }
    } finally {
      await cur.close()
    }
    await batch.flush()
  }
  let indexes = 0
  if (opt.mode !== 'data') {
    const specs = await src.listIndexes(typedRead).toArray()
    indexes = await createIndexes(dst, name, specs, report, log)
  }
  log(`${name}: ${batch.count} documents, ${indexes} indexes`)
}

/** Replaces the target collection in all and schema mode, and empties it in data mode. */
async function prepare(db: Db, name: string, opt: CopyOptions): Promise<Collection> {
  const coll = db.collection(name)
  if (opt.mode !== 'data') {
    await coll.drop()
    await db.createCollection(name)
  } else {
    await coll.deleteMany({})
  }
  return coll
}

function warn(report: CopyReport, log: Log, line: string) {
  report.warnings.push(line)
  log(line)
}

/** Inserts documents in unordered batches; documents the target refuses become warnings. */
class Batch {
  private docs: Document[] = []
  count = 0

  constructor(
    readonly coll: Collection,
    private name: string,
    private report: CopyReport,
    private log: Log,
  ) {}

  async add(doc: Document, signal?: AbortSignal) {
    this.docs.push(doc)
    if (this.docs.length >= batchSize) {
      await this.flush()
      signal?.throwIfAborted()
    }
  }

  async flush() {
    if (!this.docs.length) return
    const n = this.docs.length
    try {
      await this.coll.insertMany(this.docs, { ordered: false })
    } catch (e) {
      if (!(e instanceof MongoBulkWriteError)) throw e
      // E.g. a document the target's own unique index refuses.
      const errors = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
      const first = errors[0]?.errmsg ?? e.message
      warn(this.report, this.log, `${this.name}: ${errors.length} documents skipped (${first})`)
    }
    this.count += n
    this.docs = []
  }
}

async function createIndexes(coll: Collection, name: string, specs: Document[], report: CopyReport, log: Log) {
  let made = 0
  for (const spec of specs) {
    const model = indexModel(spec)
    if (!model) continue
    try {
      await coll.createIndex(model.keys, model.options)
      made++
    } catch (e) {
      warn(report, log, `${name}: index not created: ${errorMessage(e)}`)
    }
  }
  return made
}

/** Turns a listIndexes entry back into a create request. The _id index exists already. */
export function indexModel(spec: Document): { keys: IndexSpecification; options: CreateIndexesOptions } | undefined {
  if (spec.name === '_id_') return undefined
  const options: CreateIndexesOptions = {}
  for (const [k, v] of docEntries(spec)) {
    switch (k) {
      case 'name':
        options.name = String(v)
        break
      case 'unique':
        options.unique = v === true
        break
      case 'sparse':
        options.sparse = v === true
        break
      case 'expireAfterSeconds':
        options.expireAfterSeconds = toNumber(v)
        break
      case 'partialFilterExpression':
        options.partialFilterExpression = v as Document
        break
      case 'collation':
        if (isDoc(v)) options.collation = v as CreateIndexesOptions['collation']
        break
      case 'weights':
        options.weights = v as Document
        break
      case 'default_language':
        options.default_language = String(v)
        break
      case '2dsphereIndexVersion':
        options['2dsphereIndexVersion'] = toNumber(v)
        break
    }
  }
  return { keys: spec.key as IndexSpecification, options }
}

// ---------- dump and import ----------

/** Wraps a raw BSON document as a {doc: ...} record without decoding it. */
function docRecord(raw: Uint8Array): Buffer {
  const size = 4 + 1 + 4 + raw.length + 1 // size, type byte, "doc\0", the document, the closing 0
  const b = Buffer.alloc(size)
  b.writeInt32LE(size, 0)
  b[4] = 0x03
  b.write('doc\0', 5, 'latin1')
  b.set(raw, 9)
  return b
}

export async function dumpMongo(
  url: string,
  opt: CopyOptions,
  out: Writable,
  log: Log,
  signal?: AbortSignal,
): Promise<void> {
  const name = urlDatabase(url)
  if (!name) throw new Error('put the database in the connection URL, e.g. mongodb://host:27017/shop')
  const client = mongoClient(url)
  const gz = createGzip()
  // The caller owns out and ends it; this only waits until everything is written into it.
  const piped = pipeline(gz, out, { end: false })
  piped.catch(() => {}) // checked below; this only stops an unhandled rejection
  const write = async (b: Uint8Array) => {
    if (!gz.write(b)) await once(gz, 'drain', signal ? { signal } : {})
  }
  try {
    const db = client.db(name)
    const specs = await db.listCollections({}, { nameOnly: false }).toArray()
    await write(BSON.serialize({ magic: dumpMagic, version: new BSON.Int32(1), database: name, mode: opt.mode }))
    for (const spec of specs) {
      const collName = String(spec.name)
      if (collName.startsWith('system.') || spec.type === 'view') {
        if (spec.type === 'view') log(`skipped view ${collName}: views are not dumped`)
        continue
      }
      signal?.throwIfAborted()
      const coll = db.collection(collName)
      const rec: Document = { collection: collName }
      let indexes: Document[] = []
      if (opt.mode !== 'data') {
        indexes = await coll.listIndexes(typedRead).toArray()
        if (indexes.length) rec.indexes = indexes
      }
      await write(BSON.serialize(rec))
      let n = 0
      if (opt.mode !== 'schema') {
        // raw keeps every document byte for byte, key order and types included.
        const cur = coll.find({}, { raw: true, batchSize, ...(signal ? { signal } : {}) })
        try {
          for await (const raw of cur) {
            await write(docRecord(raw as unknown as Uint8Array))
            if (++n % batchSize === 0) signal?.throwIfAborted()
          }
        } finally {
          await cur.close()
        }
      }
      log(`${collName}: ${n} documents, ${indexes.length} indexes`)
    }
    gz.end()
    await piped
  } catch (e) {
    gz.destroy()
    throw e
  } finally {
    await client.close().catch(() => {})
  }
}

/** Splits a stream of concatenated BSON documents into single documents. */
async function* bsonDocuments(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let buf: Buffer = Buffer.alloc(0)
  for await (const chunk of chunks) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    let off = 0
    while (buf.length - off >= 4) {
      const n = buf.readUInt32LE(off)
      if (n < 5 || n > 64 << 20) throw new Error('the dump file is damaged')
      if (buf.length - off < n) break
      yield buf.subarray(off, off + n)
      off += n
    }
    buf = buf.subarray(off)
  }
  if (buf.length) throw new Error('unexpected EOF')
}

export async function restoreMongo(
  url: string,
  opt: CopyOptions,
  path: string,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  const report: CopyReport = { warnings: [] }
  const notDump = 'not an altivola-db MongoDB dump (expected a .mongo.gz file made by altivola-db or slimdb)'

  const head = Buffer.alloc(2)
  const fh = await open(path)
  try {
    const { bytesRead } = await fh.read(head, 0, 2, 0)
    if (bytesRead < 2 || head[0] !== 0x1f || head[1] !== 0x8b) throw new Error(notDump)
  } finally {
    await fh.close()
  }

  const file = createReadStream(path, { highWaterMark: 1 << 20 })
  const gunzip = createGunzip()
  file.on('error', (e) => gunzip.destroy(e))
  const docs = bsonDocuments(file.pipe(gunzip))
  const next = async () => {
    try {
      const r = await docs.next()
      return r.done ? undefined : r.value
    } catch (e) {
      throw new Error(`read the dump: ${errorMessage(e)}`)
    }
  }

  let client: ReturnType<typeof mongoClient> | undefined
  try {
    let header: Document
    try {
      const raw = await next()
      if (!raw) throw new Error(notDump)
      header = deserialize(raw)
    } catch {
      throw new Error(notDump)
    }
    if (header.magic !== dumpMagic && header.magic !== oldDumpMagic) throw new Error(notDump)
    const headDB = String(header.database ?? '')
    const name = urlDatabase(url) || headDB
    client = mongoClient(url)
    const db = client.db(name)
    log(`importing a dump of ${headDB} (${String(header.mode ?? '')}) into ${name}`)

    let current: { name: string; batch: Batch; indexes: Document[] } | undefined
    const finish = async () => {
      if (!current) return
      await current.batch.flush()
      let made = 0
      if (opt.mode !== 'data') {
        made = await createIndexes(current.batch.coll, current.name, current.indexes, report, log)
      }
      log(`${current.name}: ${current.batch.count} documents, ${made} indexes`)
    }

    for (;;) {
      const raw = await next()
      if (!raw) break
      signal?.throwIfAborted()
      let rec: Document
      try {
        rec = deserialize(raw)
      } catch {
        throw new Error('the dump file is damaged')
      }
      if (isDoc(rec.doc)) {
        if (!current || opt.mode === 'schema') continue
        await current.batch.add(rec.doc as Document, signal)
        continue
      }
      if (typeof rec.collection !== 'string' || !rec.collection) throw new Error('the dump file is damaged')
      await finish()
      const coll = await prepare(db, rec.collection, opt)
      const indexes = Array.isArray(rec.indexes) ? (rec.indexes as Document[]) : []
      current = { name: rec.collection, batch: new Batch(coll, rec.collection, report, log), indexes }
    }
    await finish()
    return report
  } finally {
    file.destroy()
    await client?.close().catch(() => {})
  }
}
