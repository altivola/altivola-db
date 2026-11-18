import {
  type Conn,
  checkCopy,
  checkDump,
  copyDatabase,
  dumpFileName,
  errorMessage,
  isLocalTarget,
  kindFromURL,
  openDriver,
  type Result,
} from '@app/core'
import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { apiError, findConn, openConn, pub } from './context.ts'
import * as s from './schemas.ts'

export const defaultLimit = 500
export const maxLimit = 100_000

const connections = {
  list: pub
    .route({ method: 'GET', path: '/connections', summary: 'Saved connections, URLs included', tags: ['connections'] })
    .output(z.array(s.conn))
    .handler(({ context }) => context.store.conns()),

  save: pub
    .route({ method: 'POST', path: '/connections', summary: 'Create or update a connection', tags: ['connections'] })
    .input(s.connInput)
    .output(s.conn)
    .handler(({ context, input }) => {
      try {
        return context.store.save(input)
      } catch (e) {
        throw apiError(e)
      }
    }),

  test: pub
    .route({ method: 'POST', path: '/connections/test', summary: 'Try to connect', tags: ['connections'] })
    .input(s.connInput)
    .output(z.object({ ok: z.boolean(), ms: z.number() }))
    .handler(async ({ input }) => {
      const start = performance.now()
      try {
        const d = await openDriver({ kind: kindFromURL(input.url), url: input.url.trim(), readOnly: input.readOnly })
        await d.close()
      } catch (e) {
        throw apiError(e)
      }
      return { ok: true, ms: Math.round(performance.now() - start) }
    }),

  remove: pub
    .route({ method: 'DELETE', path: '/connections/{id}', summary: 'Delete a connection', tags: ['connections'] })
    .input(s.connId)
    .handler(({ context, input }) => {
      try {
        context.store.delete(input.id)
      } catch (e) {
        throw apiError(e)
      }
      context.dbs.forget(input.id)
    }),

  tree: pub
    .route({
      method: 'GET',
      path: '/connections/{id}/tree',
      summary: 'Schemas and tables, or databases and collections',
      tags: ['browse'],
    })
    .input(s.connId)
    .output(z.array(s.treeNode))
    .handler(async ({ context, input }) => {
      const { driver } = await openConn(context, input.id)
      try {
        return await driver.tree()
      } catch (e) {
        throw apiError(e, 'BAD_GATEWAY')
      }
    }),

  describe: pub
    .route({
      method: 'GET',
      path: '/connections/{id}/describe',
      summary: 'Columns, indexes and constraints of an object',
      tags: ['browse'],
    })
    .input(s.connId.extend({ object: z.string(), database: z.string().default('') }))
    .output(s.results)
    .handler(async ({ context, input }) => {
      const { driver } = await openConn(context, input.id)
      try {
        return { results: await driver.describe(input.database, input.object) }
      } catch (e) {
        throw apiError(e, 'BAD_GATEWAY')
      }
    }),

  query: pub
    .route({ method: 'POST', path: '/connections/{id}/query', summary: 'Run statements', tags: ['query'] })
    .input(
      s.connId.extend({
        query: z.string(),
        database: z.string().default(''),
        limit: z.number().int().default(defaultLimit),
      }),
    )
    .output(s.results)
    .handler(async ({ context, input, signal }) => {
      const { conn, driver } = await openConn(context, input.id)
      const limit = Math.min(input.limit > 0 ? input.limit : defaultLimit, maxLimit)
      const start = performance.now()
      let results: Result[] = []
      let error: string | undefined
      try {
        results = await driver.query(input.database, input.query, limit, signal)
        error = results[results.length - 1]?.error
      } catch (e) {
        error = errorMessage(e)
      }
      context.store.addHistory({
        connId: conn.id,
        ...(input.database ? { database: input.database } : {}),
        query: input.query,
        source: 'ui',
        at: new Date().toISOString(),
        ms: Math.round(performance.now() - start),
        ...(error ? { error } : {}),
      })
      if (!results.length && error) throw new ORPCError('BAD_GATEWAY', { message: error })
      return { results }
    }),

  explain: pub
    .route({
      method: 'POST',
      path: '/connections/{id}/explain',
      summary: 'Query plan of the first statement',
      tags: ['query'],
    })
    .input(
      s.connId.extend({ query: z.string(), database: z.string().default(''), analyze: z.boolean().default(false) }),
    )
    .output(s.results)
    .handler(async ({ context, input }) => {
      const { driver } = await openConn(context, input.id)
      try {
        return { results: await driver.explain(input.database, input.query, input.analyze) }
      } catch (e) {
        throw apiError(e)
      }
    }),

  edit: pub
    .route({
      method: 'POST',
      path: '/connections/{id}/edit',
      summary: 'Save changes made in the results grid',
      tags: ['query'],
    })
    .input(s.connId.extend({ database: z.string().default(''), object: z.string(), ops: z.array(s.editOp) }))
    .output(s.result)
    .handler(async ({ context, input }) => {
      const { conn, driver } = await openConn(context, input.id)
      if (conn.readOnly) throw new ORPCError('FORBIDDEN', { message: 'this connection is read-only' })
      if (!driver.apply)
        throw new ORPCError('BAD_REQUEST', { message: `${conn.kind} results cannot be edited in the grid` })
      if (!input.ops.length) throw new ORPCError('BAD_REQUEST', { message: 'nothing to save' })
      const changes = { object: input.object, ops: input.ops }
      const start = performance.now()
      let res: Result | undefined
      let error: string | undefined
      try {
        res = await driver.apply(input.database, changes)
      } catch (e) {
        error = errorMessage(e)
      }
      // History keeps a readable record of what the grid changed.
      context.store.addHistory({
        connId: conn.id,
        ...(input.database ? { database: input.database } : {}),
        query: `-- grid edit\n${JSON.stringify(changes)}`,
        source: 'ui',
        at: new Date().toISOString(),
        ms: Math.round(performance.now() - start),
        ...(error ? { error } : {}),
      })
      if (!res) throw new ORPCError('BAD_REQUEST', { message: error ?? 'not saved' })
      return res
    }),

  dumpCheck: pub
    .route({
      method: 'GET',
      path: '/connections/{id}/dump/check',
      summary: 'Check a dump can start, and name its file',
      tags: ['transfer'],
    })
    .input(s.connId.extend({ mode: s.mode, schemas: z.string().default('') }))
    .output(z.object({ file: z.string() }))
    .handler(async ({ context, input }) => {
      const conn = findConn(context, input.id)
      try {
        checkDump(conn, { mode: input.mode })
      } catch (e) {
        throw apiError(e)
      }
      const { driver } = await openConn(context, input.id)
      try {
        await driver.tree() // finds a database that does not answer before the download starts
      } catch (e) {
        throw apiError(e, 'BAD_GATEWAY')
      }
      return { file: dumpFileName(conn, input.mode) }
    }),
}

const transfer = {
  copy: pub
    .route({ method: 'POST', path: '/copy', summary: 'Copy a database into another connection', tags: ['transfer'] })
    .input(
      z.object({
        source: z.string(),
        target: z.string(),
        mode: s.mode,
        schemas: z.array(z.string()).default([]),
        /** Must repeat the target's name when it is not on this machine. */
        confirm: z.string().default(''),
      }),
    )
    .output(s.job)
    .handler(({ context, input }) => {
      const src = findConn(context, input.source)
      const dst = findConn(context, input.target)
      const opt = { mode: input.mode, schemas: input.schemas }
      try {
        checkCopy(src, dst, opt)
      } catch (e) {
        throw apiError(e)
      }
      checkConfirm(dst, input.confirm)
      try {
        return context.jobs.start(src.name, dst, input.mode, (log, signal) => copyDatabase(src, dst, opt, log, signal))
      } catch (e) {
        throw apiError(e, 'CONFLICT')
      }
    }),

  job: pub
    .route({ method: 'GET', path: '/copy/{id}', summary: 'A copy or import job', tags: ['transfer'] })
    .input(z.object({ id: z.string() }))
    .output(s.job)
    .handler(({ context, input }) => {
      const job = context.jobs.get(input.id)
      if (!job) throw new ORPCError('NOT_FOUND', { message: 'no such copy' })
      return job
    }),

  cancel: pub
    .route({ method: 'POST', path: '/copy/{id}/cancel', summary: 'Stop a copy or import', tags: ['transfer'] })
    .input(z.object({ id: z.string() }))
    .handler(({ context, input }) => {
      if (!context.jobs.cancel(input.id)) throw new ORPCError('NOT_FOUND', { message: 'no such copy' })
    }),
}

/** A target that is not on this machine must be confirmed by typing its name. */
export function checkConfirm(target: Pick<Conn, 'name' | 'url' | 'kind'>, confirm: string) {
  if (!isLocalTarget(target) && confirm.trim() !== target.name) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${JSON.stringify(target.name)} is not on this machine; type its name to confirm overwriting it`,
    })
  }
}

export const router = {
  health: pub
    .route({ method: 'GET', path: '/health', summary: 'Health check', tags: ['system'] })
    .output(z.object({ ok: z.boolean() }))
    .handler(() => ({ ok: true })),
  connections,
  transfer,
  history: pub
    .route({ method: 'GET', path: '/history', summary: 'Recent statements, newest first', tags: ['query'] })
    .input(z.object({ conn: z.string().default('') }))
    .output(z.array(s.historyEntry))
    .handler(({ context, input }) => context.store.history(input.conn, 200)),
}

export type Router = typeof router
export type { Context } from './context.ts'
export { apiError, findConn } from './context.ts'
export { Jobs, type JobView } from './jobs.ts'
