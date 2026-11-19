// Exposes the saved connections to AI agents over the Model Context Protocol (stdio).

import {
  type Conn,
  type Driver,
  errorMessage,
  kindFromURL,
  type Manager,
  openDriver,
  type Result,
  type Store,
} from '@app/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const defaultLimit = 100
const maxLimit = 1000

const text = (s: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: s }], isError })
const json = (v: unknown, isError = false) => text(JSON.stringify(v), isError)
const fail = (e: unknown) => text(errorMessage(e), true)

/** Drops what an agent does not need: MongoDB results carry the documents themselves instead of the flattened grid. */
export function compact(results: Result[]) {
  return results.map((r) => {
    const out: Record<string, unknown> = {}
    if (r.title) out.title = r.title
    if (r.statement) out.statement = r.statement
    if (r.docs?.length) {
      out.docs = r.docs.map((d) => {
        try {
          return JSON.parse(d)
        } catch {
          return d
        }
      })
    } else if (r.columns.length) {
      out.columns = r.columns.map((c) => c.name)
      out.rows = r.rows
    }
    if (r.affected) out.affected = r.affected
    if (r.truncated) out.truncated = true
    if (r.message) out.message = r.message
    if (r.error) out.error = r.error
    out.ms = r.ms
    return out
  })
}

const connection = z.string().describe('connection name or id')
const database = z
  .string()
  .optional()
  .describe('MongoDB database, or Redis database number; defaults to the one in the connection URL')

export function createMcpServer(store: Store, dbs: Manager, version: string) {
  const server = new McpServer({ name: 'altivola-db', version })

  // Tool calls still running, so the process waits for them before it closes the drivers.
  let running = 0
  let waiters: (() => void)[] = []
  const idle = () => (running ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve())
  const register = ((name: string, config: object, cb: (...args: unknown[]) => Promise<CallToolResult>) =>
    server.registerTool(name, config, (async (...args: unknown[]) => {
      running++
      try {
        return await cb(...args)
      } finally {
        if (--running === 0) {
          for (const w of waiters) w()
          waiters = []
        }
      }
    }) as never)) as unknown as typeof server.registerTool

  async function open(name: string): Promise<{ conn: Conn; driver: Driver }> {
    let conn: Conn
    try {
      conn = store.conn(name)
    } catch (e) {
      throw new Error(`${errorMessage(e)}: ${JSON.stringify(name)} (call list_connections to see the names)`)
    }
    return { conn, driver: await dbs.get(conn) }
  }

  register(
    'list_connections',
    {
      description:
        'List the saved database connections (name, kind, read-only flag). Connection URLs are not returned.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return json(store.conns().map((c) => ({ name: c.name, id: c.id, kind: c.kind, readOnly: c.readOnly })))
      } catch (e) {
        return fail(e)
      }
    },
  )

  register(
    'add_connection',
    {
      description:
        'Save a new connection. The URL starts with postgres://, mysql:// (also MariaDB), sqlserver://, sqlite: ' +
        '(e.g. sqlite:///path/app.db), mongodb:// or mongodb+srv://, redis:// (rediss:// for TLS), ' +
        'or d1://<api token>@<account id>/<database id> for Cloudflare D1.',
      inputSchema: {
        name: z.string().describe('a short unique name for the connection'),
        url: z.string().describe('connection URL, e.g. postgres://user:pass@localhost:5432/app'),
        readOnly: z.boolean().optional().describe('refuse writes on this connection'),
      },
    },
    async ({ name, url, readOnly }) => {
      try {
        const d = await openDriver({ kind: kindFromURL(url), url: url.trim(), readOnly: !!readOnly }).catch((e) => {
          throw new Error(`could not connect, nothing saved: ${errorMessage(e)}`)
        })
        await d.close()
        const saved = store.save({ name, url, readOnly: !!readOnly })
        return text(`saved ${saved.kind} connection ${JSON.stringify(saved.name)} (id ${saved.id})`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  register(
    'list_objects',
    {
      description:
        'List schemas or databases and their tables and views (SQL databases), databases and their collections (MongoDB), ' +
        "or databases and their keys with each key's type (Redis, at most 1000 keys per database).",
      inputSchema: { connection },
      annotations: { readOnlyHint: true },
    },
    async ({ connection }) => {
      try {
        const { driver } = await open(connection)
        // One line per schema or database keeps this compact for large databases.
        const lines = (await driver.tree()).map((n) => {
          const items = (n.children ?? []).map((c) =>
            c.kind === 'table' || c.kind === 'collection' ? c.name : `${c.name} (${c.kind})`,
          )
          return `${n.kind} ${n.name}:${items.length ? ` ${items.join(', ')}` : ' (empty)'}`
        })
        return text(lines.join('\n'))
      } catch (e) {
        return fail(e)
      }
    },
  )

  register(
    'describe',
    {
      description:
        'Describe a table, collection or key. SQL databases: columns, indexes and constraints of e.g. "public.users" ' +
        '(Postgres), "shop.users" (MySQL), "dbo.Orders" (SQL Server) or "users" (SQLite). ' +
        'MongoDB: fields inferred from a sample, and indexes. Redis: type, TTL and value of a key.',
      inputSchema: {
        connection,
        object: z.string().describe('SQL: schema.table (or table), MongoDB: collection name, Redis: key'),
        database,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, object, database }) => {
      try {
        const { driver } = await open(connection)
        return json(compact(await driver.describe(database ?? '', object)))
      } catch (e) {
        return fail(e)
      }
    },
  )

  register(
    'query',
    {
      description:
        'Run one or more statements and return the results. SQL databases take SQL separated by semicolons ' +
        '(SQL Server also accepts GO lines). Redis takes one command per line, e.g. HGETALL user:1. ' +
        'MongoDB takes mongosh syntax, e.g. db.users.find({age: {$gt: 30}}).sort({name: 1}), ' +
        'db.orders.aggregate([...]), db.users.updateOne({...}, {$set: {...}}), db.runCommand({...}), show collections. ' +
        'Statements run in order and stop at the first error. Writes are allowed unless the connection is read-only.',
      inputSchema: {
        connection,
        query: z.string().describe('SQL for SQL databases, mongosh syntax for MongoDB, commands for Redis'),
        database,
        limit: z.number().int().optional().describe('maximum rows per statement, default 100, max 1000'),
      },
    },
    async ({ connection, query, database, limit }) => {
      let conn: Conn
      let driver: Driver
      try {
        ;({ conn, driver } = await open(connection))
      } catch (e) {
        return fail(e)
      }
      const start = performance.now()
      let results: Result[] = []
      let error: string | undefined
      try {
        results = await driver.query(
          database ?? '',
          query,
          Math.min(limit && limit > 0 ? limit : defaultLimit, maxLimit),
        )
        error = results[results.length - 1]?.error
      } catch (e) {
        error = errorMessage(e)
      }
      store.addHistory({
        connId: conn.id,
        ...(database ? { database } : {}),
        query,
        source: 'mcp',
        at: new Date().toISOString(),
        ms: Math.round(performance.now() - start),
        ...(error ? { error } : {}),
      })
      if (!results.length) return text(error ?? 'nothing ran', true)
      return json(compact(results), !!error)
    },
  )

  register(
    'explain',
    {
      description:
        'Show the query plan of the first statement. With analyze=true the statement really runs ' +
        '(Postgres, MySQL and SQL Server roll it back; MongoDB uses executionStats). Not available for Redis.',
      inputSchema: {
        connection,
        query: z.string().describe('the statement to explain'),
        database,
        analyze: z.boolean().optional().describe('run the statement to get real timings'),
      },
    },
    async ({ connection, query, database, analyze }) => {
      try {
        const { driver } = await open(connection)
        return json(compact(await driver.explain(database ?? '', query, !!analyze)))
      } catch (e) {
        return fail(e)
      }
    },
  )

  return Object.assign(server, { idle })
}

export async function runMcp(store: Store, dbs: Manager, version: string) {
  const server = createMcpServer(store, dbs, version)
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
    process.stdin.on('end', () => resolve())
  })
  await server.idle()
}
