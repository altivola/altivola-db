import { isIP } from 'node:net'
import type { Conn } from './types.ts'

/**
 * Replaces localhost hosts in a connection URL with alias.
 *
 * Inside a container, localhost is the container itself. Setting
 * ALTIVOLA_DB_LOCALHOST_ALIAS=host.docker.internal lets the same saved
 * connection reach a database on the host machine. Other hosts, user info,
 * the path and the query string stay as they are; MongoDB's comma separated
 * host lists are handled host by host.
 */
export function rewriteLocalhost(raw: string, alias: string | undefined): string {
  if (!alias) return raw
  const i = raw.indexOf('://')
  if (i < 0) return raw
  const rest = raw.slice(i + 3)
  let end = rest.search(/[/?]/)
  if (end < 0) end = rest.length
  let authority = rest.slice(0, end)
  let userinfo = ''
  const at = authority.lastIndexOf('@')
  if (at >= 0) {
    userinfo = authority.slice(0, at + 1)
    authority = authority.slice(at + 1)
  }
  const hosts = authority.split(',').map((h) => {
    let name = h
    let port = ''
    if (h.startsWith('[')) {
      const j = h.indexOf(']')
      if (j >= 0) {
        name = h.slice(0, j + 1)
        port = h.slice(j + 1)
      }
    } else {
      const j = h.lastIndexOf(':')
      if (j >= 0) {
        name = h.slice(0, j)
        port = h.slice(j)
      }
    }
    return ['localhost', '127.0.0.1', '[::1]'].includes(name.toLowerCase()) ? alias + port : h
  })
  return raw.slice(0, i + 3) + userinfo + hosts.join(',') + rest.slice(end)
}

/** The URL a driver should dial, after the container localhost rewrite. */
export function dialURL(url: string): string {
  return rewriteLocalhost(url, process.env.ALTIVOLA_DB_LOCALHOST_ALIAS)
}

/**
 * Whether the connection points at this machine, so the UI and CLI can ask
 * for confirmation before overwriting anything else.
 */
export function isLocalTarget(c: Pick<Conn, 'url' | 'kind'>): boolean {
  if (c.kind === 'sqlite') return true
  const m = /^[a-z+]+:\/\/(?:[^@/?]*@)?([^/?]*)/i.exec(c.url)
  if (!m) return false
  const hosts = m[1] ? m[1].split(',') : ['localhost'] // unix socket or the driver default
  return hosts.every((h) => {
    let host = h
    if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'))
    else if (host.includes(':')) host = host.slice(0, host.lastIndexOf(':'))
    host = host.toLowerCase()
    if (host === '' || host === 'localhost' || host === 'host.docker.internal') return true
    if (isIP(host) === 4) return host.startsWith('127.')
    return host === '::1'
  })
}
