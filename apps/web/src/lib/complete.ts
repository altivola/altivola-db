// Autocomplete for the query editor: SQL keywords, snippets, tables and
// columns (also after an alias, `c.`); MongoDB collections, methods, fields
// and operators; Redis commands.

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { api, type Conn, type TreeNode } from './api'
import { activeTab, loadTree, useApp } from './state'

const SQL_KEYWORDS = [
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'in',
  'is null',
  'is not null',
  'like',
  'ilike',
  'between',
  'exists',
  'join',
  'left join',
  'right join',
  'inner join',
  'full join',
  'cross join',
  'on',
  'using',
  'group by',
  'order by',
  'having',
  'limit',
  'offset',
  'distinct',
  'as',
  'asc',
  'desc',
  'nulls first',
  'nulls last',
  'union',
  'union all',
  'except',
  'intersect',
  'with',
  'case',
  'when',
  'then',
  'else',
  'end',
  'insert into',
  'values',
  'returning',
  'update',
  'set',
  'delete from',
  'on conflict',
  'do nothing',
  'do update set',
  'begin',
  'commit',
  'rollback',
  'create table',
  'create index',
  'alter table',
  'add column',
  'drop column',
  'drop table',
  'truncate',
  'explain',
  'analyze',
  'true',
  'false',
  'null',
  'now()',
  'count(*)',
  'coalesce(',
  'sum(',
  'avg(',
  'min(',
  'max(',
  'array_agg(',
  'string_agg(',
  'json_agg(',
  'jsonb_build_object(',
  'date_trunc(',
  'extract(',
  'cast(',
  'lower(',
  'upper(',
  'length(',
  'over (',
  'partition by',
  'filter (where',
]

// Snippets end where a table goes, so the list reopens with tables.
const SQL_SNIPPETS: Completion[] = [
  { label: 'sel', apply: 'select * from ', detail: 'select * from …', type: 'text', boost: 2 },
  { label: 'selc', apply: 'select count(*) from ', detail: 'select count(*) from …', type: 'text', boost: 2 },
  { label: 'seld', apply: 'select distinct ', detail: 'select distinct …', type: 'text', boost: 2 },
  { label: 'ins', apply: 'insert into ', detail: 'insert into …', type: 'text', boost: 2 },
  { label: 'upd', apply: 'update ', detail: 'update … set', type: 'text', boost: 2 },
  { label: 'del', apply: 'delete from ', detail: 'delete from …', type: 'text', boost: 2 },
]

const MONGO_METHODS = [
  'find({})',
  'findOne({})',
  'aggregate([])',
  'countDocuments({})',
  'estimatedDocumentCount()',
  'distinct("")',
  'insertOne({})',
  'insertMany([])',
  'updateOne({}, { $set: {} })',
  'updateMany({}, { $set: {} })',
  'replaceOne({}, {})',
  'deleteOne({})',
  'deleteMany({})',
  'createIndex({})',
  'dropIndex("")',
  'getIndexes()',
  'drop()',
]
const MONGO_CURSOR = ['sort({})', 'limit()', 'skip()', 'project({})', 'hint({})', 'count()']
const MONGO_DB = [
  'getCollection("")',
  'getSiblingDB("")',
  'runCommand({})',
  'stats()',
  'getCollectionNames()',
  'createCollection("")',
  'dropDatabase()',
]
const MONGO_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$and',
  '$or',
  '$nor',
  '$not',
  '$exists',
  '$type',
  '$regex',
  '$elemMatch',
  '$size',
  '$all',
  '$expr',
  '$text',
  '$near',
  '$geoWithin',
  '$geoIntersects',
  '$set',
  '$unset',
  '$inc',
  '$push',
  '$pull',
  '$addToSet',
  '$match',
  '$group',
  '$project',
  '$sort',
  '$limit',
  '$skip',
  '$lookup',
  '$unwind',
  '$count',
  '$addFields',
  '$facet',
  '$sum',
  '$avg',
  '$min',
  '$max',
  '$first',
  '$last',
]
const MONGO_TOP = [
  'show dbs',
  'show collections',
  'use ',
  'db.',
  'ObjectId("")',
  'ISODate("")',
  'NumberLong()',
  'NumberDecimal("")',
]

const REDIS_COMMANDS = [
  'GET',
  'SET',
  'DEL',
  'EXISTS',
  'EXPIRE',
  'TTL',
  'TYPE',
  'KEYS',
  'SCAN',
  'INCR',
  'DECR',
  'MGET',
  'MSET',
  'APPEND',
  'STRLEN',
  'HGET',
  'HSET',
  'HGETALL',
  'HDEL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HSCAN',
  'LPUSH',
  'RPUSH',
  'LPOP',
  'RPOP',
  'LRANGE',
  'LLEN',
  'SADD',
  'SREM',
  'SMEMBERS',
  'SCARD',
  'SSCAN',
  'SISMEMBER',
  'ZADD',
  'ZREM',
  'ZRANGE',
  'ZSCORE',
  'ZCARD',
  'ZSCAN',
  'XADD',
  'XRANGE',
  'XLEN',
  'INFO',
  'DBSIZE',
  'PING',
  'MEMORY USAGE',
  'OBJECT ENCODING',
  'CONFIG GET',
  'CLIENT LIST',
  'SLOWLOG GET',
  'JSON.GET',
  'JSON.SET',
]

const columnCache = new Map<string, Promise<{ name: string; type: string }[]>>()

/** Columns of a table (SQL) or fields of a collection (MongoDB), read through describe and cached. */
function columnsFor(conn: Conn, object: string, database = '') {
  const key = `${conn.id}|${database}|${object}`
  let p = columnCache.get(key)
  if (!p) {
    p = api.connections
      .describe({ id: conn.id, object, database })
      .then((d) => (d.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]), type: r[1] ? String(r[1]) : '' })))
      .catch(() => {
        columnCache.delete(key)
        return []
      })
    columnCache.set(key, p)
  }
  return p
}

export function resetCompletions() {
  columnCache.clear()
}

/** Loads the object tree once, so tables can be suggested before the connection was expanded. */
async function treeOf(conn: Conn): Promise<TreeNode[]> {
  if (!useApp.getState().trees[conn.id]) await loadTree(conn)
  for (let i = 0; i < 50 && useApp.getState().trees[conn.id]?.loading; i++) await new Promise((r) => setTimeout(r, 100))
  return useApp.getState().trees[conn.id]?.nodes ?? []
}

/** The statement around pos: after the last ';' or blank line before it, up to the next one. */
function statementAround(doc: string, pos: number) {
  const before = doc.slice(0, pos)
  const blank = [...before.matchAll(/\n[ \t]*\n/g)].map((m) => (m.index ?? 0) + m[0].length - 1)
  const cut = Math.max(before.lastIndexOf(';'), ...blank)
  const start = cut < 0 ? 0 : cut + 1
  const m = doc.slice(pos).match(/;|\n[ \t]*\n/)
  return doc.slice(start, m ? pos + (m.index ?? 0) : doc.length)
}

const unquote = (s: string) =>
  s
    .replace(/^"|"$/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^\[|\]$/g, '')

/** Tables named after from/join/update/into in the statement, with their aliases. */
function referencedTables(stmt: string) {
  const re =
    /\b(?:from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+))?)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/gi
  const notAlias =
    /^(where|on|using|join|left|right|inner|full|cross|natural|group|order|limit|offset|set|values|select|returning|as|lateral|union|except|intersect|having|window|for)$/i
  return [...stmt.matchAll(re)].map((m) => ({ object: m[1] ?? '', alias: m[2] && !notAlias.test(m[2]) ? m[2] : null }))
}

function tableOptions(conn: Conn, nodes: TreeNode[]): Completion[] {
  const out: Completion[] = []
  const defaults = ['public', 'dbo', 'main']
  for (const group of nodes) {
    for (const t of group.children ?? []) {
      const object = t.object ?? t.name
      // Tables in the default schema can go without it.
      const short = defaults.includes(group.name) || conn.kind === 'mysql' ? t.name : object
      out.push({
        label: short,
        apply: /^[\w$]+$/.test(short) ? short : object,
        detail: `${t.kind} in ${group.name}`,
        type: 'class',
        boost: 1,
      })
      if (short !== object) out.push({ label: object, detail: t.kind, type: 'class' })
    }
  }
  return out
}

/** Finds a tree table by how the statement wrote it. */
function findTable(nodes: TreeNode[], written: string): TreeNode | undefined {
  const parts = written.split('.').map(unquote)
  const name = (parts[parts.length - 1] ?? '').toLowerCase()
  const schema = parts.length > 1 ? (parts[0] ?? '').toLowerCase() : null
  for (const g of nodes) {
    if (schema && g.name.toLowerCase() !== schema) continue
    const t = g.children?.find((c) => c.name.toLowerCase() === name)
    if (t) return t
  }
  return undefined
}

const sqlSource: CompletionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
  const conn = currentConn()
  if (!conn) return null
  const word = ctx.matchBefore(/[\w$."`[\]]*/)
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  const doc = ctx.state.doc.toString()
  const stmt = statementAround(doc, ctx.pos)
  const nodes = await treeOf(conn)
  const text = word.text
  const dot = text.lastIndexOf('.')

  // alias.col or table.col
  if (dot >= 0) {
    const head = text.slice(0, dot)
    const from = word.from + dot + 1
    const refs = referencedTables(stmt)
    const ref =
      refs.find((r) => r.alias && r.alias.toLowerCase() === head.toLowerCase()) ??
      refs.find((r) => unquote(r.object.split('.').pop() ?? '').toLowerCase() === unquote(head).toLowerCase())
    if (ref) {
      const t = findTable(nodes, ref.object)
      if (!t) return null
      const cols = await columnsFor(conn, t.object ?? t.name, t.database)
      return {
        from,
        options: cols.map((c) => ({ label: c.name, detail: c.type, type: 'property' })),
        validFor: /^[\w$]*$/,
      }
    }
    // schema.table
    const group = nodes.find((g) => g.name.toLowerCase() === unquote(head).toLowerCase())
    if (group) {
      return {
        from,
        options: (group.children ?? []).map((t) => ({ label: t.name, detail: t.kind, type: 'class' })),
        validFor: /^[\w$]*$/,
      }
    }
    return null
  }

  const before = doc.slice(0, word.from)
  const afterTableWord = /\b(from|join|update|into|table|describe)\s+$/i.test(before)
  const options: Completion[] = tableOptions(conn, nodes)
  if (!afterTableWord) {
    const cols = await Promise.all(
      referencedTables(stmt).map(async (r) => {
        const t = findTable(nodes, r.object)
        return t ? columnsFor(conn, t.object ?? t.name, t.database) : []
      }),
    )
    const seen = new Set<string>()
    for (const c of cols.flat()) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      options.push({ label: c.name, detail: c.type, type: 'property', boost: 3 })
    }
    options.push(...SQL_SNIPPETS, ...SQL_KEYWORDS.map((k) => ({ label: k, type: 'keyword' })))
  }
  return { from: word.from, options, validFor: /^[\w$]*$/ }
}

const mongoSource: CompletionSource = async (ctx) => {
  const conn = currentConn()
  if (!conn) return null
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const nodes = await treeOf(conn)
  const tab = activeTab()
  const dbName = tab?.db || nodes[0]?.name || ''
  const collections = nodes.find((n) => n.name === dbName)?.children ?? nodes.flatMap((n) => n.children ?? [])

  let m = /\$[\w]*$/.exec(before)
  if (m) return { from: ctx.pos - m[0].length, options: MONGO_OPERATORS.map((o) => ({ label: o, type: 'keyword' })) }

  m = /\bdb\.([\w$]*)$/.exec(before)
  if (m) {
    return {
      from: ctx.pos - (m[1]?.length ?? 0),
      options: [
        ...collections.map((c) => ({ label: c.name, detail: c.kind, type: 'class', boost: 1 })),
        ...MONGO_DB.map((x) => ({ label: x, type: 'method' })),
      ],
      validFor: /^[\w$]*$/,
    }
  }
  m = /\bdb\.(?:[\w$]+|getCollection\([^)]*\))\.([\w$]*)$/.exec(before)
  if (m)
    return {
      from: ctx.pos - (m[1]?.length ?? 0),
      options: MONGO_METHODS.map((x) => ({ label: x, type: 'method' })),
      validFor: /^[\w$]*$/,
    }
  m = /\)\.([\w$]*)$/.exec(before)
  if (m)
    return {
      from: ctx.pos - (m[1]?.length ?? 0),
      options: MONGO_CURSOR.map((x) => ({ label: x, type: 'method' })),
      validFor: /^[\w$]*$/,
    }

  // Field names inside the braces of a call on a collection.
  const stmt = statementAround(ctx.state.doc.toString(), ctx.pos)
  const coll = /\bdb\.(?:getCollection\(\s*["']([^"']+)["']\s*\)|([\w$]+))\./.exec(stmt)
  const word = ctx.matchBefore(/[\w$.]*/)
  if (coll && /[{,]\s*[\w$.]*$/.test(before)) {
    const name = coll[1] ?? coll[2] ?? ''
    const fields = await columnsFor(conn, name, dbName)
    return {
      from: word?.from ?? ctx.pos,
      options: fields.map((f) => ({ label: f.name, detail: f.type, type: 'property' })),
      validFor: /^[\w$.]*$/,
    }
  }
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  return { from: word.from, options: MONGO_TOP.map((x) => ({ label: x, type: 'keyword' })) }
}

const redisSource: CompletionSource = async (ctx) => {
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const m = /^\s*([\w.]*)$/.exec(before)
  if (!m || (!m[1] && !ctx.explicit)) return null
  return {
    from: ctx.pos - (m[1]?.length ?? 0),
    options: REDIS_COMMANDS.map((c) => ({ label: c, type: 'keyword' })),
    validFor: /^[\w.]*$/i,
  }
}

function currentConn(): Conn | undefined {
  const s = useApp.getState()
  const t = activeTab(s)
  return t && s.conns.find((c) => c.id === t.connId)
}

export function completionSource(kind: Conn['kind']): CompletionSource {
  if (kind === 'mongo') return mongoSource
  if (kind === 'redis') return redisSource
  return sqlSource
}
