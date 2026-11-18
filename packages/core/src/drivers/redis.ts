import { createClient, ErrorReply, RESP_TYPES } from 'redis'
import {
  type Cell,
  type Column,
  type Driver,
  emptyResult,
  errorMessage,
  ReadOnlyError,
  type Result,
  type TreeNode,
} from '../types.ts'

/** Keys listed per database in the tree. */
const treeKeys = 1000
/** Spare query connections kept per database. */
const spareConns = 4

/** A decoded RESP3 reply, with maps kept as Map and integers as text. */
export type Reply = string | number | bigint | boolean | null | Error | Reply[] | Map<Reply, Reply>

/**
 * Maps are decoded as Map so they stay apart from arrays and keep any key,
 * and integers as text so values above 2^53 stay exact.
 */
const replyTypes = { [RESP_TYPES.MAP]: Map, [RESP_TYPES.NUMBER]: String }

type Client = {
  sendCommand<T>(args: readonly string[], options?: { typeMapping?: typeof replyTypes }): Promise<T>
  close(): Promise<void>
  destroy(): void
}

/** Opens one connection. The first connect fails fast; later drops reconnect. */
async function connect(url: string): Promise<Client> {
  let ready = false
  const c = createClient({
    url,
    RESP: 3,
    name: 'altivola-db',
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries: number) => (ready ? Math.min(2 ** retries * 50, 2000) : false),
    },
  })
  // Without a listener, a dropped connection would crash the process.
  c.on('error', () => {})
  await c.connect()
  ready = true
  return c
}

function send(c: Client, args: readonly string[]): Promise<Reply> {
  return c.sendCommand<Reply>(args, { typeMapping: replyTypes })
}

/** openRedis takes redis://[user:pass@]host:6379[/db] or rediss:// for TLS. readOnly refuses commands that write. */
export async function openRedis(url: string, readOnly: boolean): Promise<Driver> {
  const d = new RedisDriver(url, readOnly)
  try {
    await send(await d.client(d.defaultDB), ['PING'])
  } catch (e) {
    await d.close()
    throw e
  }
  return d
}

/** Commands refused on a read-only connection. */
const writes = new Set(
  `set setnx setex psetex mset msetnx getset getdel getex append incr incrby incrbyfloat
  decr decrby setrange del unlink expire expireat pexpire pexpireat persist rename renamenx move copy restore
  lpush lpushx rpush rpushx lpop rpop lset lrem ltrim linsert lmove blmove rpoplpush brpoplpush blpop brpop lmpop blmpop
  sadd srem spop smove sinterstore sunionstore sdiffstore
  zadd zincrby zrem zremrangebyrank zremrangebyscore zremrangebylex zpopmin zpopmax bzpopmin bzpopmax zmpop bzmpop
  zunionstore zinterstore zdiffstore zrangestore
  hset hsetnx hmset hdel hincrby hincrbyfloat hexpire hpexpire hpersist hgetdel hgetex hsetex
  xadd xdel xtrim xgroup xack xclaim xautoclaim xsetid
  pfadd pfmerge geoadd georadius georadiusbymember geosearchstore setbit bitop bitfield
  json.set json.del json.forget json.arrappend json.arrinsert json.arrpop json.arrtrim json.clear
  json.merge json.mset json.numincrby json.strappend json.toggle
  flushdb flushall swapdb eval evalsha eval_ro fcall function script config shutdown save bgsave bgrewriteaof
  replicaof slaveof debug migrate publish spublish`
    .split(/\s+/)
    .filter(Boolean),
)
writes.delete('eval_ro')

const unsupported: Record<string, string> = {
  subscribe: 'subscribing',
  psubscribe: 'subscribing',
  ssubscribe: 'subscribing',
  monitor: 'MONITOR',
  multi: 'MULTI/EXEC',
  exec: 'MULTI/EXEC',
  watch: 'WATCH',
}

/** Commands that change the connection's own state, so the connection is not reused after them. */
const connState = new Set(['select', 'client', 'hello', 'auth', 'reset', 'readonly', 'readwrite'])

class RedisDriver implements Driver {
  readonly defaultDB: number
  /** One client per logical database, for the tree and describe. */
  private clients = new Map<number, Promise<Client>>()
  /** Spare connections for query(), per database. */
  private spare = new Map<number, Client[]>()
  /** Query connections in use, so close() can stop them. */
  private busy = new Set<Client>()

  constructor(
    private url: string,
    private readOnly: boolean,
  ) {
    const path = new URL(url).pathname
    this.defaultDB = path.length > 1 ? Number(path.slice(1)) : 0
  }

  private urlFor(n: number): string {
    const u = new URL(this.url)
    u.pathname = `/${n}`
    return u.toString()
  }

  client(n: number): Promise<Client> {
    let c = this.clients.get(n)
    if (!c) {
      c = connect(this.urlFor(n))
      const p = c
      p.catch(() => {
        if (this.clients.get(n) === p) this.clients.delete(n)
      })
      this.clients.set(n, c)
    }
    return c
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    for (const c of this.busy) c.destroy()
    this.busy.clear()
    for (const list of this.spare.values()) for (const c of list) c.destroy()
    this.spare.clear()
    await Promise.all(clients.map((p) => p.then((c) => c.close()).catch(() => {})))
  }

  /** dbIndex reads "3" or "db3"; empty means the database from the URL. */
  private dbIndex(database: string): number {
    if (database === '') return this.defaultDB
    const s = database.toLowerCase().replace(/^db/, '')
    const n = /^[+-]?\d+$/.test(s) ? Number(s) : Number.NaN
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`bad Redis database ${JSON.stringify(database)}, use a number such as 0`)
    }
    return n
  }

  /** Lists every non-empty database with up to treeKeys keys each. A key's kind is its Redis type. */
  async tree(): Promise<TreeNode[]> {
    const info = await send(await this.client(this.defaultDB), ['INFO', 'keyspace'])
    const dbs = new Set<number>([this.defaultDB])
    for (const raw of String(info).split('\n')) {
      const line = raw.trim()
      const colon = line.indexOf(':')
      if (colon < 0 || !line.startsWith('db')) continue
      const num = line.slice(2, colon)
      if (/^\d+$/.test(num)) dbs.add(Number(num))
    }
    const out: TreeNode[] = []
    for (const n of [...dbs].sort((a, b) => a - b)) {
      const c = await this.client(n)
      let keys: string[] = []
      let cursor = '0'
      do {
        const reply = (await send(c, ['SCAN', cursor, 'MATCH', '*', 'COUNT', '500'])) as [string, string[]]
        cursor = String(reply[0])
        keys.push(...reply[1].map(String))
      } while (cursor !== '0' && keys.length < treeKeys)
      keys = keys.slice(0, treeKeys).sort(compare)
      // Sent in the same tick, so node-redis pipelines them.
      const types = await Promise.all(keys.map((k) => send(c, ['TYPE', k])))
      out.push({
        name: `db${n}`,
        kind: 'database',
        children: keys.map((k, i) => ({ name: k, kind: String(types[i]), object: k, database: String(n) })),
      })
    }
    return out
  }

  async describe(database: string, key: string): Promise<Result[]> {
    const n = this.dbIndex(database)
    const c = await this.client(n)
    const type = String(await send(c, ['TYPE', key]))
    if (type === 'none') throw new Error(`key ${JSON.stringify(key)} not found in db${n}`)
    const info = emptyResult({ title: 'Key', columns: cols('property', 'value') })
    const add = (k: string, v: Cell) => info.rows.push([k, v])
    add('key', key)
    add('type', type)
    const ttl = Number(await send(c, ['TTL', key]))
    if (ttl === -1) add('ttl', 'no expiry')
    else if (ttl > 0) add('ttl', duration(ttl))
    try {
      const mem = await send(c, ['MEMORY', 'USAGE', key])
      if (mem !== null) add('memory', `${mem} bytes`)
    } catch {
      // Some servers do not have MEMORY USAGE.
    }
    const length = async (cmd: string) => {
      const l = Number(await send(c, [cmd, key]))
      add('length', l)
      return l
    }

    const max = 1000
    const val = emptyResult({ title: 'Value' })
    switch (type) {
      case 'string': {
        val.columns = cols('value')
        val.rows.push([text(await send(c, ['GET', key]))])
        break
      }
      case 'list': {
        const l = await length('LLEN')
        const items = (await send(c, ['LRANGE', key, '0', String(max - 1)])) as Reply[]
        val.columns = cols('index', 'value')
        items.forEach((v, i) => {
          val.rows.push([String(i), text(v)])
        })
        val.truncated = l > max
        break
      }
      case 'set': {
        const l = await length('SCARD')
        const reply = (await send(c, ['SSCAN', key, '0', 'MATCH', '*', 'COUNT', String(max)])) as [Reply, Reply[]]
        const items = reply[1].map(String).sort(compare)
        val.columns = cols('member')
        for (const v of items) val.rows.push([v])
        val.truncated = l > items.length
        break
      }
      case 'zset': {
        const l = await length('ZCARD')
        const items = (await send(c, ['ZRANGE', key, '0', String(max - 1), 'WITHSCORES'])) as Reply[][]
        val.columns = cols('member', 'score')
        for (const [member, score] of items) val.rows.push([text(member ?? null), text(score ?? null)])
        val.truncated = l > max
        break
      }
      case 'hash': {
        await length('HLEN')
        const m = (await send(c, ['HGETALL', key])) as Map<Reply, Reply>
        val.columns = cols('field', 'value')
        for (const [f, v] of sortedEntries(m)) val.rows.push([f, text(v)])
        break
      }
      case 'stream': {
        const l = await length('XLEN')
        const msgs = (await send(c, ['XRANGE', key, '-', '+', 'COUNT', '100'])) as [Reply, Reply[]][]
        val.columns = cols('id', 'fields')
        for (const [id, fields] of msgs) {
          const m = new Map<Reply, Reply>()
          for (let i = 0; i + 1 < fields.length; i += 2) m.set(String(fields[i]), fields[i + 1] ?? null)
          val.rows.push([text(id), toJSON(m)])
        }
        val.truncated = l > 100
        break
      }
      default:
        return [info]
    }
    return [info, val]
  }

  /** Runs one command per line on one connection. Lines starting with # or // are comments. */
  async query(database: string, q: string, limit: number, signal?: AbortSignal): Promise<Result[]> {
    const n = this.dbIndex(database)
    const lines = q
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('//'))
    if (lines.length === 0) throw new Error('nothing to run')
    const conn = await this.take(n)
    let reuse = true
    // Dropping the connection stops a command that is still running, such as BLPOP.
    const onAbort = () => {
      reuse = false
      conn.destroy()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const out: Result[] = []
    try {
      for (const line of lines) {
        if (signal?.aborted) break
        const res = await this.runLine(conn, line, limit, () => {
          reuse = false
        })
        if (signal?.aborted && res.error) res.error = 'canceled'
        out.push(res)
        if (res.error) break
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.giveBack(n, conn, reuse && !signal?.aborted)
    }
    return out
  }

  private async take(n: number): Promise<Client> {
    const conn = this.spare.get(n)?.pop() ?? (await connect(this.urlFor(n)))
    this.busy.add(conn)
    return conn
  }

  private giveBack(n: number, conn: Client, reuse: boolean) {
    if (!this.busy.delete(conn)) return // close() already dropped it
    const list = this.spare.get(n) ?? []
    if (reuse && list.length < spareConns) {
      list.push(conn)
      this.spare.set(n, list)
    } else {
      conn.destroy()
    }
  }

  private async runLine(conn: Client, line: string, limit: number, dirty: () => void): Promise<Result> {
    const res = emptyResult({ statement: line })
    const start = performance.now()
    try {
      let args: string[]
      try {
        args = splitCommand(line)
      } catch (e) {
        res.error = errorMessage(e)
        return res
      }
      const name = (args[0] ?? '').toLowerCase()
      const what = unsupported[name]
      if (what) {
        res.error = `${what} is not supported here`
        return res
      }
      if (this.readOnly && writes.has(name)) {
        res.error = new ReadOnlyError().message
        return res
      }
      if (connState.has(name)) dirty()
      let v: Reply
      try {
        v = await send(conn, args)
      } catch (e) {
        // A server error reply leaves the connection fine; anything else may not.
        if (!(e instanceof ErrorReply)) dirty()
        res.error = errorMessage(e)
        return res
      }
      shapeRedis(name, v, limit, res)
      return res
    } finally {
      res.ms = Math.round(performance.now() - start)
    }
  }

  async explain(): Promise<Result[]> {
    return [emptyResult({ title: 'Plan', error: 'explain is not available for Redis' })]
  }
}

const scans = new Set(['scan', 'sscan', 'hscan', 'zscan'])

/** shapeRedis turns a reply into a table on res. */
export function shapeRedis(cmd: string, v: Reply, limit: number, res: Result): void {
  res.rows = []
  const add = (...row: Cell[]): boolean => {
    if (limit > 0 && res.rows.length >= limit) {
      res.truncated = true
      return false
    }
    res.rows.push(row)
    return true
  }
  if (v instanceof Map) {
    res.columns = cols('field', 'value')
    for (const [k, val] of sortedEntries(v)) {
      if (!add(k, text(val))) break
    }
    return
  }
  if (Array.isArray(v)) {
    if (scans.has(cmd) && v.length === 2) {
      res.message = `next cursor ${text(v[0] ?? null)} (0 means done)`
      const items = Array.isArray(v[1]) ? v[1] : []
      if (cmd === 'hscan' || cmd === 'zscan') {
        res.columns = cols('field', 'value')
        for (let i = 0; i + 1 < items.length; i += 2) {
          if (!add(text(items[i] ?? null), text(items[i + 1] ?? null))) break
        }
        return
      }
      res.columns = cols('value')
      for (const it of items) {
        if (!add(text(it))) break
      }
      return
    }
    // An array of equal-length scalar arrays, such as ZRANGE WITHSCORES on RESP3.
    const width = tupleWidth(v)
    if (width > 0) {
      res.columns = cols('#')
      for (let i = 1; i <= width; i++) res.columns.push({ name: `value ${i}` })
      for (const [i, it] of v.entries()) {
        if (!add(String(i + 1), ...(it as Reply[]).map(text))) break
      }
      return
    }
    res.columns = cols('#', 'value')
    for (const [i, it] of v.entries()) {
      if (!add(String(i + 1), text(it))) break
    }
    return
  }
  if (typeof v === 'string' && cmd === 'info') {
    res.columns = cols('key', 'value')
    for (const raw of v.split('\n')) {
      const l = raw.trim()
      const colon = l.indexOf(':')
      if (colon >= 0 && !l.startsWith('#')) add(l.slice(0, colon), l.slice(colon + 1))
    }
    return
  }
  res.columns = cols('value')
  add(text(v))
}

function tupleWidth(v: Reply[]): number {
  let width = 0
  for (const it of v) {
    if (!Array.isArray(it) || it.length === 0 || (width !== 0 && it.length !== width)) return 0
    if (it.some((x) => Array.isArray(x) || x instanceof Map)) return 0
    width = it.length
  }
  return width
}

/** Renders a reply value as text; nested replies become JSON. */
export function text(v: Reply): string | null {
  if (v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return num(v)
  if (typeof v === 'bigint' || typeof v === 'boolean') return String(v)
  if (v instanceof Error) return v.message
  return toJSON(v)
}

function num(n: number): string {
  if (Number.isFinite(n)) return String(n)
  return Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf'
}

/** JSON with map keys sorted, like Go's encoding/json. */
function toJSON(v: Reply): string {
  if (v === null) return 'null'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(num(v))
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (v instanceof Error) return JSON.stringify(v.message)
  if (Array.isArray(v)) return `[${v.map(toJSON).join(',')}]`
  return `{${sortedEntries(v)
    .map(([k, x]) => `${JSON.stringify(k)}:${toJSON(x)}`)
    .join(',')}}`
}

/** A map's entries with text keys, sorted by key. A repeated key keeps its last value. */
function sortedEntries(m: Map<Reply, Reply>): [string, Reply][] {
  const byKey = new Map<string, Reply>()
  for (const [k, v] of m) byKey.set(String(text(k)), v)
  return [...byKey.entries()].sort((a, b) => compare(a[0], b[0]))
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function cols(...names: string[]): Column[] {
  return names.map((name) => ({ name }))
}

/** Formats whole seconds like Go's time.Duration, e.g. 1h0m5s. */
function duration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m}m${s}s`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

/**
 * splitCommand splits a line like the redis-cli does: on spaces, with
 * "double" (backslash escapes) and 'single' quoted arguments.
 */
export function splitCommand(line: string): string[] {
  const args: string[] = []
  let cur = ''
  let inArg = false
  const r = Array.from(line)
  for (let i = 0; i < r.length; i++) {
    const c = r[i]
    if (c === ' ' || c === '\t') {
      if (inArg) {
        args.push(cur)
        cur = ''
        inArg = false
      }
    } else if (c === '"' || c === "'") {
      inArg = true
      const q = c
      let closed = false
      for (i++; i < r.length; i++) {
        if (r[i] === '\\' && i + 1 < r.length && (q === '"' || r[i + 1] === "'")) {
          i++
          const e = r[i]
          cur += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e
          continue
        }
        if (r[i] === q) {
          closed = true
          break
        }
        cur += r[i]
      }
      if (!closed) throw new Error(`unbalanced quotes in ${JSON.stringify(line)}`)
    } else {
      inArg = true
      cur += c
    }
  }
  if (inArg) args.push(cur)
  if (args.length === 0) throw new Error('empty command')
  return args
}
