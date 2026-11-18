// altivola-db: a slim local database client for PostgreSQL, MySQL, SQLite,
// SQL Server, MongoDB and Redis, with a browser UI and an MCP server.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Jobs } from '@app/api'
import {
  type CopyOptions,
  checkDump,
  copyDatabase,
  dumpDatabase,
  dumpFileName,
  errorMessage,
  isLocalTarget,
  Manager,
  restoreDatabase,
  Store,
} from '@app/core'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { runMcp } from './mcp.ts'

declare const __VERSION__: string | undefined
const version = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const defaultAddr = '127.0.0.1:7789'

const usage = (
  dir: string,
) => `altivola-db: a slim database client for PostgreSQL, MySQL, SQLite, SQL Server, MongoDB and Redis

Usage:
  altivola-db [serve] [--addr ${defaultAddr}] [--no-browser]   start the web UI
  altivola-db mcp                                          run the MCP server on stdio
  altivola-db conn list                                    list saved connections
  altivola-db conn add [--read-only] <name> <url>          save a connection
  altivola-db conn rename <name> <new-name>                rename a connection
  altivola-db conn rm <name>                               delete a connection
  altivola-db conn import <connections.json>               add the connections of a slimdb (or altivola-db) file
  altivola-db copy [--mode all|schema|data] [--schema a,b] [--yes] <source> <target>
                                                           copy a database into another connection
  altivola-db dump [--mode all|schema|data] [--schema a,b] <conn> [file]
                                                           dump a database to a file (default: a dated name here)
  altivola-db import [--mode all|schema|data] [--schema a,b] [--yes] <file> <conn>
                                                           load a dump file into a connection
  altivola-db version

Connections and history are stored in ${dir}
(override with ALTIVOLA_DB_HOME).
`

const store = new Store()
const [cmd = 'serve', ...rest] = process.argv[2]?.startsWith('-')
  ? ['serve', ...process.argv.slice(2)]
  : process.argv.slice(2)

function transferArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'all' },
      schema: { type: 'string', default: '' },
      yes: { type: 'boolean', default: false },
    },
  })
  const opt: CopyOptions = {
    mode: values.mode as CopyOptions['mode'],
    schemas: String(values.schema)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
  return { opt, values, positionals }
}

const log = (line: string) => console.error(line)
const secs = (start: number) => `${Math.round((performance.now() - start) / 1000)}s`

async function main() {
  switch (cmd) {
    case 'serve':
      return serveCmd(rest)
    case 'mcp': {
      const dbs = new Manager()
      await runMcp(store, dbs, version)
      await dbs.closeAll()
      return
    }
    case 'conn':
      return connCmd(rest)
    case 'copy': {
      const { opt, values, positionals } = transferArgs(rest)
      if (positionals.length !== 2)
        throw new Error('usage: altivola-db copy [--mode all|schema|data] [--schema a,b] [--yes] <source> <target>')
      const src = store.conn(positionals[0] ?? '')
      const dst = store.conn(positionals[1] ?? '')
      if (!isLocalTarget(dst) && !values.yes)
        throw new Error(`${JSON.stringify(dst.name)} is not on this machine; pass --yes to overwrite it anyway`)
      const start = performance.now()
      const report = await copyDatabase(src, dst, opt, log)
      console.info(
        `copied ${src.name} into ${dst.name} (${opt.mode}) in ${secs(start)}, ${report.warnings.length} warnings`,
      )
      for (const w of report.warnings) console.info(`  ${w}`)
      return
    }
    case 'dump': {
      const { opt, positionals } = transferArgs(rest)
      if (positionals.length < 1 || positionals.length > 2)
        throw new Error('usage: altivola-db dump [--mode all|schema|data] [--schema a,b] <conn> [file]')
      const c = store.conn(positionals[0] ?? '')
      checkDump(c, opt)
      const path = positionals[1] || dumpFileName(c, opt.mode)
      const out = createWriteStream(path, { flags: 'wx', mode: 0o600 })
      await once(out, 'open')
      const start = performance.now()
      try {
        await dumpDatabase(c, opt, out, log)
        out.end()
        await once(out, 'finish')
      } catch (e) {
        out.destroy()
        unlinkSync(path)
        throw e
      }
      console.info(`dumped ${c.name} (${opt.mode}) into ${path}, ${statSync(path).size} bytes in ${secs(start)}`)
      return
    }
    case 'import': {
      const { opt, values, positionals } = transferArgs(rest)
      if (positionals.length !== 2)
        throw new Error('usage: altivola-db import [--mode all|schema|data] [--schema a,b] [--yes] <file> <conn>')
      const c = store.conn(positionals[1] ?? '')
      if (!isLocalTarget(c) && !values.yes)
        throw new Error(`${JSON.stringify(c.name)} is not on this machine; pass --yes to overwrite it anyway`)
      const start = performance.now()
      const report = await restoreDatabase(c, opt, positionals[0] ?? '', log)
      console.info(
        `imported ${positionals[0]} into ${c.name} (${opt.mode}) in ${secs(start)}, ${report.warnings.length} warnings`,
      )
      for (const w of report.warnings) console.info(`  ${w}`)
      return
    }
    case 'version':
    case '-v':
    case '--version':
      console.info(version)
      return
    case 'help':
    case '-h':
    case '--help':
      console.info(usage(store.dir))
      return
    default:
      console.error(usage(store.dir))
      process.exit(2)
  }
}

function connCmd(args: string[]) {
  const [sub, ...rest] = args
  switch (sub) {
    case 'list':
    case 'ls': {
      const conns = store.conns()
      const rows = [
        ['NAME', 'KIND', 'READ-ONLY', 'ID'],
        ...conns.map((c) => [c.name, c.kind, String(c.readOnly), c.id]),
      ]
      const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
      for (const r of rows)
        console.info(
          r
            .map((x, i) => x.padEnd((widths[i] ?? 0) + 2))
            .join('')
            .trimEnd(),
        )
      return
    }
    case 'add': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'read-only': { type: 'boolean', default: false } },
      })
      if (positionals.length !== 2) throw new Error('usage: altivola-db conn add [--read-only] <name> <url>')
      const c = store.save({ name: positionals[0] ?? '', url: positionals[1] ?? '', readOnly: !!values['read-only'] })
      console.info(`saved ${c.kind} connection ${JSON.stringify(c.name)}`)
      return
    }
    case 'rename':
    case 'mv': {
      if (rest.length !== 2) throw new Error('usage: altivola-db conn rename <name> <new-name>')
      const c = store.conn(rest[0] ?? '')
      store.save({ ...c, name: rest[1] ?? '' })
      console.info(`renamed ${JSON.stringify(rest[0])} to ${JSON.stringify(rest[1])}`)
      return
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      if (rest.length !== 1) throw new Error('usage: altivola-db conn rm <name>')
      const c = store.conn(rest[0] ?? '')
      store.delete(c.id)
      console.info(`deleted ${JSON.stringify(c.name)}`)
      return
    }
    case 'import': {
      if (rest.length !== 1) throw new Error('usage: altivola-db conn import <connections.json>')
      const list = JSON.parse(readFileSync(rest[0] ?? '', 'utf8'))
      if (!Array.isArray(list)) throw new Error('expected a JSON array of connections')
      let added = 0
      for (const c of list) {
        try {
          store.save({ name: String(c.name), url: String(c.url), readOnly: !!c.readOnly })
          added++
        } catch (e) {
          console.error(`skipped ${JSON.stringify(c.name)}: ${errorMessage(e)}`)
        }
      }
      console.info(`imported ${added} of ${list.length} connections`)
      return
    }
  }
  throw new Error(
    'usage: altivola-db conn list | add [--read-only] <name> <url> | rename <name> <new-name> | rm <name> | import <file>',
  )
}

function splitAddr(addr: string): { host: string; port: number } {
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(addr)
  if (!m) throw new Error(`bad address ${JSON.stringify(addr)}, use host:port`)
  return { host: m[1] ?? '', port: Number(m[2]) }
}

function webDir(): string | undefined {
  const dir = process.env.ALTIVOLA_DB_WEB_DIR ?? fileURLToPath(new URL('./web', import.meta.url))
  return existsSync(dir) ? dir : undefined
}

async function serveCmd(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { addr: { type: 'string', default: defaultAddr }, 'no-browser': { type: 'boolean', default: false } },
  })
  const { host, port } = splitAddr(String(values.addr))
  // Inside a container the server must listen on all interfaces; the Docker
  // image opts in, and the port should be published on 127.0.0.1.
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (!loopback && process.env.ALTIVOLA_DB_LISTEN_ANY !== '1') {
    throw new Error(
      `refusing to listen on ${values.addr}: altivola-db runs queries for whoever can reach it, keep it on localhost`,
    )
  }

  const dbs = new Manager()
  const token = process.env.ALTIVOLA_DB_TOKEN || randomBytes(16).toString('hex')
  const app = createApp({ store, dbs, jobs: new Jobs(dbs), token, webDir: webDir() })

  const listen = (p: number) =>
    new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const server = serve({ fetch: app.fetch, hostname: host, port: p })
      server.once('listening', () => resolve(server))
      server.once('error', reject)
    })
  let server: ReturnType<typeof serve>
  try {
    server = await listen(port)
  } catch (e) {
    if ((e as { code?: string }).code !== 'EADDRINUSE') throw e
    server = await listen(0) // the port is taken (maybe by another altivola-db): pick a free one
  }
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  const shown =
    host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host.includes(':') ? `[${host}]` : host
  const url = `http://${shown}:${actual}`
  console.info(`altivola-db ${version} running at ${url} (Ctrl+C to stop)`)
  if (!values['no-browser']) openBrowser(url)

  const stop = async () => {
    server.close()
    await dbs.closeAll()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function openBrowser(url: string) {
  const [bin, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url]
  try {
    spawn(bin ?? 'open', args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // no browser here; the URL is printed
  }
}

main().catch((e) => {
  console.error(errorMessage(e))
  process.exit(1)
})
