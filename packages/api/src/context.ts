import { type Conn, type Driver, errorMessage, type Manager, NotFoundError, type Store } from '@app/core'
import { ORPCError, os } from '@orpc/server'
import type { Jobs } from './jobs.ts'

export type Context = {
  store: Store
  dbs: Manager
  jobs: Jobs
}

export const pub = os.$context<Context>()

/** Turns an error into an API error: unknown connections are 404, everything else the given status. */
export function apiError(
  e: unknown,
  code: 'BAD_REQUEST' | 'BAD_GATEWAY' | 'CONFLICT' = 'BAD_REQUEST',
): ORPCError<string, unknown> {
  if (e instanceof ORPCError) return e
  if (e instanceof NotFoundError) return new ORPCError('NOT_FOUND', { message: e.message })
  return new ORPCError(code, { message: errorMessage(e) })
}

export function findConn(ctx: Context, id: string): Conn {
  try {
    return ctx.store.conn(id)
  } catch (e) {
    throw apiError(e)
  }
}

/** The connection and its open driver. A database that does not answer is a 502. */
export async function openConn(ctx: Context, id: string): Promise<{ conn: Conn; driver: Driver }> {
  const conn = findConn(ctx, id)
  try {
    return { conn, driver: await ctx.dbs.get(conn) }
  } catch (e) {
    throw apiError(e, 'BAD_GATEWAY')
  }
}
