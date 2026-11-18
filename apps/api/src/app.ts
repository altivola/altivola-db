import { timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, normalize, sep } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { apiError, type Context, checkConfirm, findConn, router } from '@app/api'
import { type CopyOptions, checkDump, copyModes, dumpDatabase, dumpFileName, restoreDatabase } from '@app/core'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { ORPCError, onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { Hono, type Context as HonoContext } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

export const tokenHeader = 'X-Altivola-Db-Token'
export const openapiInfo = { title: 'altivola-db API', version: '0.1.0' }

export type Deps = Context & {
  /**
   * Generated per run and put in the page. Requiring it on every API call
   * stops other websites from driving the API through the browser (CSRF);
   * the Host check stops DNS rebinding.
   */
  token: string
  /** The built web app. Without it only the API is served (dev, where Vite serves the page). */
  webDir?: string
  reportError?: (error: unknown) => void
}

export function isLoopbackHost(hostport: string): boolean {
  let host = hostport
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'))
  else if (host.split(':').length === 2) host = host.slice(0, host.indexOf(':'))
  host = host.toLowerCase()
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function transferOptions(c: HonoContext): CopyOptions {
  const mode = c.req.query('mode') || 'all'
  if (!(copyModes as readonly string[]).includes(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}`)
  const schemas = (c.req.query('schemas') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return { mode: mode as CopyOptions['mode'], schemas }
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

export function createApp(deps: Deps) {
  const { token, webDir, reportError = console.error, ...context } = deps
  const handleError = (error: unknown) => {
    if (error instanceof ORPCError && error.status < 500) return
    if (error instanceof ORPCError && error.status === 502) return // the database said no; the UI shows it
    reportError(error)
  }
  const rpc = new RPCHandler(router, { interceptors: [onError(handleError)] })
  const openapi = new OpenAPIHandler(router, {
    interceptors: [onError(handleError)],
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: openapiInfo,
          components: { securitySchemes: { token: { type: 'apiKey', in: 'header', name: tokenHeader } } },
          security: [{ token: [] }],
        },
      }),
    ],
  })

  const app = new Hono()

  app.use(async (c, next) => {
    if (!isLoopbackHost(c.req.header('host') ?? '')) {
      return c.text('altivola-db only answers on localhost', 403)
    }
    const path = c.req.path
    // The API docs page and its spec hold no data, so they open without the token.
    const open = c.req.method === 'GET' && (path === '/api' || path === '/api/spec.json')
    const guarded = path.startsWith('/rpc/') || path.startsWith('/api/') || path.startsWith('/files/')
    if (guarded && !open) {
      // A download is a plain link, which cannot send headers.
      const given = c.req.header(tokenHeader) ?? (path.startsWith('/files/dump/') ? c.req.query('token') : undefined)
      if (!sameToken(given, token)) return c.json({ error: 'missing or wrong token, reload the page' }, 401)
    }
    await next()
  })
  app.use(secureHeaders({ xFrameOptions: 'DENY', crossOriginResourcePolicy: 'same-origin' }))

  app.use('/rpc/*', async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, { prefix: '/rpc', context })
    if (matched) return c.newResponse(response.body, response)
    await next()
  })
  app.use('/api/*', async (c, next) => {
    const { matched, response } = await openapi.handle(c.req.raw, { prefix: '/api', context })
    if (matched) return c.newResponse(response.body, response)
    await next()
  })
  app.get('/api', async (c) => {
    const { response } = await openapi.handle(c.req.raw, { prefix: '/api', context })
    return response ? c.newResponse(response.body, response) : c.notFound()
  })

  // Streams a dump as a download into the browser's download folder. An
  // error before the first byte is a normal error response; an error halfway
  // aborts the response, so the browser marks the download as failed instead
  // of keeping a cut-off file.
  app.get('/files/dump/:id', async (c) => {
    const { conn, opt } = (() => {
      try {
        const opt = transferOptions(c)
        const conn = findConn(context, c.req.param('id'))
        checkDump(conn, opt)
        return { conn, opt }
      } catch (e) {
        throw toHttp(e)
      }
    })()
    let started = () => {}
    const firstByte = new Promise<void>((resolve) => {
      started = resolve
    })
    const out = new PassThrough({
      transform(chunk, _encoding, callback) {
        started()
        callback(null, chunk)
      },
    })
    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    const done = dumpDatabase(conn, opt, out, () => {}, abort.signal)
    const result = await Promise.race([
      firstByte.then(() => 'started' as const),
      done.then(
        () => 'done' as const,
        (e) => e as Error,
      ),
    ])
    if (result instanceof Error) {
      return c.json({ error: result.message }, 502)
    }
    done.then(
      () => out.end(),
      (e) => out.destroy(e instanceof Error ? e : new Error(String(e))),
    )
    return new Response(Readable.toWeb(out) as ReadableStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${dumpFileName(conn, opt.mode)}"`,
      },
    })
  })

  // Receives a dump file as the request body, saves it to a temp file and
  // imports it as a job, like a copy.
  app.post('/files/import/:id', async (c) => {
    let opt: CopyOptions
    let conn: ReturnType<typeof findConn>
    try {
      opt = transferOptions(c)
      conn = findConn(context, c.req.param('id'))
      if (conn.readOnly) throw new ORPCError('BAD_REQUEST', { message: `${JSON.stringify(conn.name)} is read-only` })
      checkConfirm(conn, c.req.query('confirm') ?? '')
    } catch (e) {
      throw toHttp(e)
    }
    const file = basename(c.req.query('file') ?? 'upload')
    const dir = await mkdtemp(join(tmpdir(), 'altivola-db-import-'))
    const path = join(dir, 'upload')
    const cleanup = () => void rm(dir, { recursive: true, force: true })
    try {
      if (!c.req.raw.body) throw new Error('empty upload')
      await pipeline(Readable.fromWeb(c.req.raw.body as never), createWriteStream(path, { mode: 0o600 }))
    } catch (e) {
      cleanup()
      return c.json({ error: `upload: ${(e as Error).message}` }, 400)
    }
    try {
      const job = context.jobs.start(
        file,
        conn,
        opt.mode,
        (log, signal) => restoreDatabase(conn, opt, path, log, signal),
        cleanup,
      )
      return c.json(job, 202)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409)
    }
  })

  if (webDir) {
    const root = normalize(webDir)
    const index = async () => (await readFile(join(root, 'index.html'), 'utf8')).replace('%ALTIVOLA_DB_TOKEN%', token)
    app.get('*', async (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '')
      const file = normalize(join(root, rel))
      if (rel && file.startsWith(root + sep)) {
        try {
          const body = await readFile(file)
          const immutable = rel.startsWith('assets/')
          return c.body(body, 200, {
            'Content-Type': types[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          })
        } catch {
          // not a file: fall through to the page
        }
      }
      if (rel.startsWith('rpc/') || rel.startsWith('api/') || rel.startsWith('files/')) return c.notFound()
      return c.html(await index(), 200, { 'Cache-Control': 'no-store' })
    })
  }

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status)
    reportError(e)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message)
  }
}

function toHttp(e: unknown): HttpError {
  const err = apiError(e)
  const status = err.status === 404 ? 404 : err.status === 409 ? 409 : err.status === 502 ? 502 : 400
  return new HttpError(err.message, status)
}
