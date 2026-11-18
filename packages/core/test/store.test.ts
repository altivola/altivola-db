import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { kindFromURL, Store } from '../src/store.ts'

const tempStore = () => new Store(mkdtempSync(join(tmpdir(), 'altivola-db-')))

it('saves, renames, finds and deletes connections', () => {
  const st = tempStore()
  const c = st.save({ name: ' local/pg ', url: 'postgres://u:p@localhost/app', readOnly: true })
  expect(c).toMatchObject({ name: 'local/pg', kind: 'postgres', readOnly: true })
  expect(c.id).toMatch(/^[0-9a-f]{12}$/)
  expect(statSync(join(st.dir, 'connections.json')).mode & 0o777).toBe(0o600)

  expect(() => st.save({ name: 'LOCAL/PG', url: 'redis://localhost' })).toThrow(/already exists/)
  expect(st.conn('local/PG').id).toBe(c.id)
  expect(st.conn(c.id).name).toBe('local/pg')

  const renamed = st.save({ ...c, name: 'work/dev/app' })
  expect(renamed.id).toBe(c.id)
  expect(st.conns()).toHaveLength(1)

  st.delete(c.id)
  expect(st.conns()).toEqual([])
  expect(() => st.conn('work/dev/app')).toThrow(/not found/)
})

it('rejects unknown URL schemes', () => {
  expect(() => kindFromURL('http://x')).toThrow(/unsupported/)
  expect(kindFromURL('mariadb://x')).toBe('mysql')
  expect(kindFromURL('sqlite:app.db')).toBe('sqlite')
  expect(kindFromURL('rediss://x')).toBe('redis')
})

it('keeps history newest first, per connection', () => {
  const st = tempStore()
  for (let i = 0; i < 5; i++) {
    st.addHistory({
      connId: i % 2 ? 'a' : 'b',
      query: `select ${i}`,
      source: 'ui',
      at: new Date().toISOString(),
      ms: 1,
    })
  }
  expect(st.history('', 10).map((e) => e.query)).toEqual(['select 4', 'select 3', 'select 2', 'select 1', 'select 0'])
  expect(st.history('a', 10).map((e) => e.query)).toEqual(['select 3', 'select 1'])
  expect(st.history('', 2)).toHaveLength(2)
})
