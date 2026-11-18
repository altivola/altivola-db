// Copying a database into another connection, dumping it to a file, and
// importing a dump. Postgres goes through pg_dump and pg_restore; MongoDB
// through the driver.

import { open } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { dialURL } from '../hostalias.ts'
import type { Conn } from '../types.ts'
import { copyMongo, dumpMongo, restoreMongo } from './mongo.ts'
import { copyPostgres, dumpPostgres, needTool, restorePostgres } from './postgres.ts'
import { type CopyOptions, type CopyReport, copyModes, type Log } from './types.ts'

export * from './types.ts'

function checkMode(opt: CopyOptions) {
  if (!copyModes.includes(opt.mode))
    throw new Error(`unknown mode ${JSON.stringify(opt.mode)} (use all, schema or data)`)
}

/** Throws why src cannot be copied into dst. */
export function checkCopy(src: Conn, dst: Conn, opt: CopyOptions) {
  if (src.id && src.id === dst.id) throw new Error('source and target are the same connection')
  if (src.kind !== dst.kind) throw new Error(`cannot copy ${src.kind} into ${dst.kind}`)
  if (src.kind !== 'postgres' && src.kind !== 'mongo') {
    throw new Error(`copying is only available for Postgres and MongoDB, not ${src.kind}`)
  }
  if (dst.readOnly) throw new Error(`target ${JSON.stringify(dst.name)} is read-only`)
  checkMode(opt)
}

/** Throws why c cannot be dumped. */
export function checkDump(c: Conn, opt: CopyOptions) {
  if (c.kind !== 'postgres' && c.kind !== 'mongo') {
    throw new Error(`dump and import support Postgres and MongoDB, not ${c.kind}`)
  }
  checkMode(opt)
  if (c.kind === 'postgres') needTool('pg_dump')
}

/** A file name like "li3-dev-app-data-20261115-1304.dump". */
export function dumpFileName(c: Pick<Conn, 'name' | 'kind'>, mode: string, now = new Date()): string {
  let name = c.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'altivola-db'
  if (mode && mode !== 'all') name += `-${mode}`
  const p = (n: number) => String(n).padStart(2, '0')
  name += `-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  return name + (c.kind === 'mongo' ? '.mongo.gz' : '.dump')
}

/** Copies a whole database from src into dst. */
export async function copyDatabase(
  src: Conn,
  dst: Conn,
  opt: CopyOptions,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  checkCopy(src, dst, opt)
  if (src.kind === 'mongo') return copyMongo(dialURL(src.url), dialURL(dst.url), opt, log, signal)
  return copyPostgres(dialURL(src.url), dialURL(dst.url), opt, log, signal)
}

/** Writes c's database to out. The caller ends out. */
export async function dumpDatabase(c: Conn, opt: CopyOptions, out: Writable, log: Log, signal?: AbortSignal) {
  checkDump(c, opt)
  if (c.kind === 'mongo') return dumpMongo(dialURL(c.url), opt, out, log, signal)
  return dumpPostgres(dialURL(c.url), opt, out, log, signal)
}

/** Loads a dump file into c, replacing what the file contains, like a copy does. */
export async function restoreDatabase(
  c: Conn,
  opt: CopyOptions,
  path: string,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  if (c.readOnly) throw new Error(`${JSON.stringify(c.name)} is read-only`)
  if (c.kind !== 'postgres' && c.kind !== 'mongo') {
    throw new Error(`dump and import support Postgres and MongoDB, not ${c.kind}`)
  }
  checkMode(opt)
  const f = await open(path)
  const head = Buffer.alloc(5)
  try {
    await f.read(head, 0, 5, 0)
  } finally {
    await f.close()
  }
  if (c.kind === 'mongo') {
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      throw new Error('not a MongoDB dump (expected a .mongo.gz file made by altivola-db or slimdb)')
    }
    return restoreMongo(dialURL(c.url), opt, path, log, signal)
  }
  return restorePostgres(dialURL(c.url), opt, path, head, log, signal)
}
