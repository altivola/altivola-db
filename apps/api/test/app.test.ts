import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jobs } from '@app/api'
import { Manager, Store } from '@app/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createApp, isLoopbackHost, tokenHeader } from '../src/app.ts'
import { createMcpServer } from '../src/mcp.ts'

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'altivola-db-')))
  const webDir = mkdtempSync(join(tmpdir(), 'altivola-db-web-'))
  writeFileSync(join(webDir, 'index.html'), '<meta name="altivola-db-token" content="%ALTIVOLA_DB_TOKEN%">')
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)')
  const dbs = new Manager()
  const app = createApp({ store, dbs, jobs: new Jobs(dbs), token: 'secret', webDir, reportError: () => {} })
  const call = (path: string, init: RequestInit & { host?: string; token?: string | null } = {}) => {
    const headers = new Headers(init.headers)
    headers.set('host', init.host ?? 'localhost:7789')
    if (init.token !== null) headers.set(tokenHeader, init.token ?? 'secret')
    return app.request(`http://localhost${path}`, { ...init, headers })
  }
  return { store, dbs, call }
}

describe('web server', () => {
  it('only answers on loopback hosts', async () => {
    const { call } = setup()
    expect((await call('/api/health', { host: 'evil.example:7789' })).status).toBe(403)
    expect((await call('/', { host: '127.0.0.1:7789' })).status).toBe(200)
    expect(isLoopbackHost('[::1]:7789')).toBe(true)
    expect(isLoopbackHost('localhost.evil.example')).toBe(false)
  })

  it('needs the token for the API', async () => {
    const { call } = setup()
    expect((await call('/api/health', { token: null })).status).toBe(401)
    expect((await call('/api/health', { token: 'wrong' })).status).toBe(401)
    expect(await (await call('/api/health')).json()).toEqual({ ok: true })
    expect((await call('/rpc/health', { method: 'POST', token: null })).status).toBe(401)
    // The docs page holds no data.
    expect((await call('/api', { token: null })).status).toBe(200)
  })

  it('puts the token in the page and serves assets', async () => {
    const { call } = setup()
    const page = await (await call('/some/route', { token: null })).text()
    expect(page).toContain('content="secret"')
    const asset = await call('/assets/app.js', { token: null })
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect((await call('/../../etc/passwd', { token: null })).status).toBe(200) // the page, not the file
  })

  it('saves, lists and deletes connections', async () => {
    const { call } = setup()
    const res = await call('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'local/pg', url: 'postgres://localhost/app' }),
    })
    expect(res.status).toBe(200)
    const saved = (await res.json()) as { id: string }
    expect(saved).toMatchObject({ name: 'local/pg', kind: 'postgres', readOnly: false })
    expect(await (await call('/api/connections')).json()).toHaveLength(1)
    const bad = await call('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', url: 'http://nope' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { message: string }).message).toMatch(/unsupported URL scheme/)
    expect((await call(`/api/connections/${saved.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/connections/nope/tree')).status).toBe(404)
  })

  it('refuses a dump of a kind that cannot be dumped', async () => {
    const { call, store } = setup()
    const c = store.save({ name: 'r', url: 'redis://localhost:1' })
    const res = await call(`/files/dump/${c.id}?token=secret`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/Postgres and MongoDB/)
  })
})

describe('mcp', () => {
  it('lists connections without their URLs', async () => {
    const { store, dbs } = setup()
    store.save({ name: 'a', url: 'postgres://u:secret@localhost/app', readOnly: true })
    const server = createMcpServer(store, dbs, 'test')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['add_connection', 'describe', 'explain', 'list_connections', 'list_objects', 'query'])
    const res = await client.callTool({ name: 'list_connections', arguments: {} })
    const text = (res.content as { text: string }[])[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual([{ name: 'a', id: expect.any(String), kind: 'postgres', readOnly: true }])
    expect(text).not.toContain('secret')
    const missing = await client.callTool({ name: 'query', arguments: { connection: 'nope', query: 'select 1' } })
    expect(missing.isError).toBe(true)
    await client.close()
  })
})
