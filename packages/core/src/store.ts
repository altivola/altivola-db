// Saved connections and query history on local disk.
//
// The web UI and the MCP server run as separate processes, so every call
// reads from disk instead of caching. Connections live in connections.json
// (written atomically, mode 0600 because it holds passwords), history in an
// append-only history.jsonl. The format is the same as slimdb's, so a slimdb
// connections.json can be imported as it is.

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Conn, type HistoryEntry, type Kind, kinds } from './types.ts'

const historyKeep = 500
const historyTrim = 2000 // trim the file back to historyKeep once it grows past this

export class NotFoundError extends Error {
  constructor(what = 'connection') {
    super(`${what} not found`)
  }
}

/** $ALTIVOLA_DB_HOME, or the user config folder plus altivola-db. */
export function defaultDir(): string {
  if (process.env.ALTIVOLA_DB_HOME) return process.env.ALTIVOLA_DB_HOME
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'altivola-db')
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'altivola-db')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'altivola-db')
  }
}

/** Guesses the connection kind from the URL scheme. */
export function kindFromURL(url: string): Kind {
  const u = url.trim().toLowerCase()
  if (u.startsWith('postgres://') || u.startsWith('postgresql://')) return 'postgres'
  if (u.startsWith('mongodb://') || u.startsWith('mongodb+srv://')) return 'mongo'
  if (u.startsWith('mysql://') || u.startsWith('mariadb://')) return 'mysql'
  if (u.startsWith('sqlite:') || u.startsWith('file:')) return 'sqlite'
  if (u.startsWith('sqlserver://')) return 'sqlserver'
  if (u.startsWith('redis://') || u.startsWith('rediss://')) return 'redis'
  if (u.startsWith('d1://')) return 'd1'
  throw new Error(
    'unsupported URL scheme, use postgres://, mysql://, mariadb://, sqlserver://, sqlite:, mongodb://, redis:// or d1://',
  )
}

export class Store {
  readonly dir: string

  constructor(dir = defaultDir()) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private get connPath() {
    return join(this.dir, 'connections.json')
  }

  private get historyPath() {
    return join(this.dir, 'history.jsonl')
  }

  conns(): Conn[] {
    if (!existsSync(this.connPath)) return []
    let list: unknown
    try {
      list = JSON.parse(readFileSync(this.connPath, 'utf8'))
    } catch (e) {
      throw new Error(`read ${this.connPath}: ${(e as Error).message}`)
    }
    if (!Array.isArray(list)) return []
    return list.map((c) => ({
      id: String(c.id),
      name: String(c.name),
      kind: kinds.includes(c.kind) ? c.kind : kindFromURL(String(c.url)),
      url: String(c.url),
      readOnly: !!c.readOnly,
    }))
  }

  /** Finds a connection by id or by name (names ignore case). */
  conn(idOrName: string): Conn {
    const c = this.conns().find((c) => c.id === idOrName || c.name.toLowerCase() === idOrName.toLowerCase())
    if (!c) throw new NotFoundError()
    return c
  }

  /** Creates the connection when id is empty and replaces it otherwise. */
  save(input: { id?: string; name: string; url: string; readOnly?: boolean }): Conn {
    const name = input.name.trim()
    const url = input.url.trim()
    if (!name || !url) throw new Error('name and url are required')
    const c: Conn = { id: input.id ?? '', name, url, kind: kindFromURL(url), readOnly: !!input.readOnly }
    const conns = this.conns()
    if (conns.some((o) => o.id !== c.id && o.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`a connection named ${JSON.stringify(name)} already exists`)
    }
    if (!c.id) {
      c.id = randomBytes(6).toString('hex')
      conns.push(c)
    } else {
      const i = conns.findIndex((o) => o.id === c.id)
      if (i < 0) throw new NotFoundError()
      conns[i] = c
    }
    this.write(conns)
    return c
  }

  delete(id: string) {
    const conns = this.conns()
    const i = conns.findIndex((c) => c.id === id)
    if (i < 0) throw new NotFoundError()
    conns.splice(i, 1)
    this.write(conns)
  }

  private write(conns: Conn[]) {
    const tmp = `${this.connPath}.tmp`
    writeFileSync(tmp, JSON.stringify(conns, null, 2), { mode: 0o600 })
    renameSync(tmp, this.connPath)
  }

  /** Appends one entry. Failures are ignored: history is a convenience. */
  addHistory(e: HistoryEntry) {
    try {
      appendFileSync(this.historyPath, `${JSON.stringify(e)}\n`, { mode: 0o600 })
      const entries = this.readHistory()
      if (entries.length > historyTrim) {
        const tmp = `${this.historyPath}.tmp`
        writeFileSync(
          tmp,
          entries
            .slice(-historyKeep)
            .map((x) => `${JSON.stringify(x)}\n`)
            .join(''),
          { mode: 0o600 },
        )
        renameSync(tmp, this.historyPath)
      }
    } catch {
      // ignore
    }
  }

  /** The newest entries first, optionally for one connection. */
  history(connId: string, limit: number): HistoryEntry[] {
    const entries = this.readHistory()
    const out: HistoryEntry[] = []
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i]
      if (e && (!connId || e.connId === connId)) out.push(e)
    }
    return out
  }

  private readHistory(): HistoryEntry[] {
    if (!existsSync(this.historyPath)) return []
    const out: HistoryEntry[] = []
    for (const line of readFileSync(this.historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip a damaged line
      }
    }
    return out
  }
}
