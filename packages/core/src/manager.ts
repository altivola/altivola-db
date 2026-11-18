import { openMongo } from './drivers/mongo.ts'
import { openMySQL } from './drivers/mysql.ts'
import { openPostgres } from './drivers/postgres.ts'
import { openRedis } from './drivers/redis.ts'
import { openSQLite } from './drivers/sqlite.ts'
import { openSQLServer } from './drivers/sqlserver.ts'
import { dialURL } from './hostalias.ts'
import type { Conn, Driver } from './types.ts'

/** Connects to c. Inside the Docker image, localhost in the URL means the host machine. */
export function openDriver(c: Pick<Conn, 'kind' | 'url' | 'readOnly'>): Promise<Driver> {
  const url = dialURL(c.url)
  switch (c.kind) {
    case 'postgres':
      return openPostgres(url, c.readOnly)
    case 'mongo':
      return openMongo(url, c.readOnly)
    case 'mysql':
      return openMySQL(url, c.readOnly)
    case 'sqlite':
      return openSQLite(url, c.readOnly)
    case 'sqlserver':
      return openSQLServer(url, c.readOnly)
    case 'redis':
      return openRedis(url, c.readOnly)
  }
  throw new Error(`unknown connection kind ${JSON.stringify(c.kind)}`)
}

const same = (a: Conn, b: Conn) =>
  a.name === b.name && a.url === b.url && a.kind === b.kind && a.readOnly === b.readOnly

/**
 * Keeps one open driver per saved connection and reopens it when the
 * connection's settings change.
 */
export class Manager {
  private open = new Map<string, { conn: Conn; driver: Promise<Driver> }>()

  get(c: Conn): Promise<Driver> {
    const o = this.open.get(c.id)
    if (o && same(o.conn, c)) return o.driver
    if (o) this.forget(c.id)
    const driver = openDriver(c)
    // A failed connect is not kept, so the next call tries again.
    driver.catch(() => {
      if (this.open.get(c.id)?.driver === driver) this.open.delete(c.id)
    })
    this.open.set(c.id, { conn: c, driver })
    return driver
  }

  forget(id: string) {
    const o = this.open.get(id)
    if (!o) return
    this.open.delete(id)
    o.driver.then((d) => d.close()).catch(() => {})
  }

  async closeAll() {
    const all = [...this.open.values()]
    this.open.clear()
    await Promise.allSettled(all.map((o) => o.driver.then((d) => d.close())))
  }
}
