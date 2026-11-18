// Postgres copy, dump and import through pg_dump, pg_restore and psql, which
// must be on PATH (the Docker image has them).

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import pg from 'pg'
import { pgConfig, pgError } from '../drivers/postgres.ts'
import type { CopyOptions, CopyReport, Log } from './types.ts'

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`

export function hasTool(name: string): boolean {
  return spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0
}

export function needTool(name: string) {
  if (!hasTool(name)) {
    throw new Error(`${name} not found: install the PostgreSQL client tools, or use the Docker image, which has them`)
  }
}

/**
 * libpq tools take the URL without the password, which goes through
 * PGPASSWORD so it does not show up in the process list.
 */
export function libpqTarget(raw: string): { uri: string; password: string } {
  const u = new URL(raw)
  const password = decodeURIComponent(u.password)
  u.password = ''
  return { uri: u.toString(), password }
}

/** One "error: ..." line per statement the target refused. */
const isPgWarning = (line: string) => line.startsWith('error: ')

type Tool = { name: string; password: string; args: string[]; stdin?: Readable; stdout?: Writable | 'pipe' }

/** Runs a libpq tool, sending its stderr lines to log and the refused statements to warnings. */
function runTool(t: Tool, log: Log, warnings: string[], signal?: AbortSignal) {
  const child = spawn(t.name, t.args, {
    env: { ...process.env, PGPASSWORD: t.password, PGCONNECT_TIMEOUT: '15' },
    stdio: [t.stdin ? 'pipe' : 'ignore', t.stdout ? 'pipe' : 'ignore', 'pipe'],
    signal,
  })
  child.on('error', () => {}) // reported through the exit promise
  if (t.stdin && child.stdin) t.stdin.pipe(child.stdin)
  if (t.stdout && t.stdout !== 'pipe' && child.stdout) child.stdout.pipe(t.stdout, { end: false })
  const lines = createInterface({ input: child.stderr as Readable })
  lines.on('line', (raw) => {
    const line = raw.startsWith(`${t.name}: `) ? raw.slice(t.name.length + 2) : raw
    if (isPgWarning(line) || line.includes('ERROR:  ')) warnings.push(line)
    log(`${t.name}: ${line}`)
  })
  const exit = new Promise<number>((resolve, reject) => {
    child.on('close', (code) => {
      if (signal?.aborted) reject(signal.reason ?? new Error('cancelled'))
      else resolve(code ?? 1)
    })
    child.on('error', reject)
  })
  return { child, exit }
}

/**
 * pg_restore and psql exit 1 when they skipped statements the target refused
 * ("errors ignored on restore"); everything else went in.
 */
function checkExit(name: string, code: number, warnings: string[]) {
  if (code === 0) return
  if (code === 1 && warnings.length && name !== 'pg_dump') return
  throw new Error(`${name} failed with exit code ${code} (see the log)`)
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client(pgConfig(url))
  try {
    await c.connect()
  } catch (e) {
    await c.end().catch(() => {})
    throw e
  }
  return c
}

/**
 * Creates the target database when it does not exist yet, so copying into a
 * fresh local server needs no manual step.
 */
export async function ensureDatabase(url: string, log: Log) {
  try {
    await (await connect(url)).end()
    return
  } catch (e) {
    if ((e as { code?: string }).code !== '3D000') throw new Error(`target: ${pgError(e)}`) // invalid_catalog_name
  }
  const u = new URL(url)
  const name = decodeURIComponent(u.pathname.slice(1))
  u.pathname = '/postgres'
  let admin: pg.Client
  try {
    admin = await connect(u.toString())
  } catch (e) {
    throw new Error(
      `target database ${JSON.stringify(name)} does not exist and the server could not be reached to create it: ${pgError(e)}`,
    )
  }
  try {
    await admin.query(`create database ${quoteIdent(name)}`)
    log(`created database ${JSON.stringify(name)} on the target`)
  } catch (e) {
    throw new Error(`create database ${JSON.stringify(name)}: ${pgError(e)}`)
  } finally {
    await admin.end()
  }
}

/** Empties the listed tables that exist in the target. */
async function truncateExisting(url: string, tables: string[], log: Log) {
  if (!tables.length) return
  let c: pg.Client
  try {
    c = await connect(url)
  } catch (e) {
    throw new Error(`target: ${pgError(e)}`)
  }
  try {
    const existing: string[] = []
    for (const t of tables) {
      const r = await c.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [t])
      if (r.rows[0]?.ok) existing.push(t)
    }
    if (!existing.length) return
    try {
      await c.query(`truncate table ${existing.join(', ')}`)
    } catch (e) {
      throw new Error(`empty target tables: ${pgError(e)}`)
    }
    log(`emptied ${existing.length} target tables`)
  } finally {
    await c.end()
  }
}

/**
 * The source's tables, so a data-only copy can empty the target's copies
 * first. Tables owned by an extension (e.g. PostGIS's spatial_ref_sys) are
 * left alone.
 */
async function sourceTables(url: string, schemas: string[]): Promise<string[]> {
  let c: pg.Client
  try {
    c = await connect(url)
  } catch (e) {
    throw new Error(`source: ${pgError(e)}`)
  }
  try {
    const r = await c.query<{ t: string }>(
      `select format('%I.%I', n.nspname, c.relname) as t
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
        and (cardinality($1::text[]) = 0 or n.nspname = any($1::text[]))
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
          and d.objid = c.oid and d.deptype = 'e')`,
      [schemas],
    )
    return r.rows.map((x) => x.t)
  } catch (e) {
    throw new Error(`list source tables: ${pgError(e)}`)
  } finally {
    await c.end()
  }
}

const cleanSchemas = (opt: CopyOptions) => (opt.schemas ?? []).map((s) => s.trim()).filter(Boolean)

function dumpArgs(src: string, opt: CopyOptions): string[] {
  const args = ['--format=custom', '--verbose', '--no-owner', '--no-privileges', `--dbname=${src}`]
  if (opt.mode === 'schema') args.push('--schema-only')
  if (opt.mode === 'data') args.push('--data-only')
  for (const s of cleanSchemas(opt)) args.push(`--schema=${s}`)
  return args
}

function restoreArgs(dst: string, opt: CopyOptions, withSchemaFlags: boolean): string[] {
  const args = ['--verbose', '--no-owner', '--no-privileges', `--dbname=${dst}`]
  if (opt.mode === 'all') args.push('--clean', '--if-exists')
  if (opt.mode === 'schema') args.push(...(withSchemaFlags ? ['--schema-only'] : []), '--clean', '--if-exists')
  // Rows arrive table by table, so foreign keys would fail on order.
  if (opt.mode === 'data') args.push(...(withSchemaFlags ? ['--data-only'] : []), '--disable-triggers')
  return args
}

export async function copyPostgres(
  srcURL: string,
  dstURL: string,
  opt: CopyOptions,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  needTool('pg_dump')
  needTool('pg_restore')
  const src = libpqTarget(srcURL)
  const dst = libpqTarget(dstURL)
  await ensureDatabase(dstURL, log)
  if (opt.mode === 'data') await truncateExisting(dstURL, await sourceTables(srcURL, cleanSchemas(opt)), log)

  const warnings: string[] = []
  log('starting pg_dump and pg_restore')
  const dump = runTool(
    { name: 'pg_dump', password: src.password, args: dumpArgs(src.uri, opt), stdout: 'pipe' },
    log,
    [],
    signal,
  )
  const restore = runTool(
    {
      name: 'pg_restore',
      password: dst.password,
      args: restoreArgs(dst.uri, opt, false),
      stdin: dump.child.stdout ?? undefined,
    },
    log,
    warnings,
    signal,
  )
  const [dumpCode, restoreCode] = await Promise.all([dump.exit, restore.exit])
  checkExit('pg_dump', dumpCode, [])
  checkExit('pg_restore', restoreCode, warnings)
  return { warnings }
}

/** Writes a pg_dump custom-format dump of the database to out. */
export async function dumpPostgres(url: string, opt: CopyOptions, out: Writable, log: Log, signal?: AbortSignal) {
  needTool('pg_dump')
  const src = libpqTarget(url)
  const t = runTool(
    { name: 'pg_dump', password: src.password, args: dumpArgs(src.uri, opt), stdout: out },
    log,
    [],
    signal,
  )
  checkExit('pg_dump', await t.exit, [])
}

/**
 * Lists the tables whose rows a custom-format dump holds, from its table of
 * contents, e.g. "4279; 0 20820 TABLE DATA ev ev_site postgres".
 */
function dumpTables(path: string): string[] {
  const r = spawnSync('pg_restore', ['--list', path], { encoding: 'utf8', maxBuffer: 256 << 20 })
  if (r.status !== 0) throw new Error(`read the dump's contents: ${r.stderr || 'pg_restore failed'}`)
  const tables: string[] = []
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith(';')) continue
    const i = line.indexOf(' TABLE DATA ')
    if (i < 0) continue
    const f = line
      .slice(i + 12)
      .trim()
      .split(/\s+/)
    if (f.length >= 2 && f[0] && f[1]) tables.push(`${quoteIdent(f[0])}.${quoteIdent(f[1])}`)
  }
  return tables
}

/**
 * Loads a dump file, replacing what it contains like a copy does. Takes
 * pg_dump custom-format files and plain SQL files.
 */
export async function restorePostgres(
  url: string,
  opt: CopyOptions,
  path: string,
  head: Buffer,
  log: Log,
  signal?: AbortSignal,
): Promise<CopyReport> {
  await ensureDatabase(url, log)
  const dst = libpqTarget(url)
  const warnings: string[] = []
  if (head.subarray(0, 5).toString('latin1') !== 'PGDMP') {
    if (head[0] === 0x1f && head[1] === 0x8b) {
      throw new Error('this looks like a MongoDB dump or a gzipped file; unzip a .sql.gz first')
    }
    if (opt.mode !== 'all') log('plain SQL file: the mode does not apply, the file runs as it is')
    needTool('psql')
    log('running the SQL file with psql')
    const t = runTool(
      {
        name: 'psql',
        password: dst.password,
        args: ['-X', '-q', '-v', 'ON_ERROR_STOP=0', `--dbname=${dst.uri}`, '-f', path],
      },
      log,
      warnings,
      signal,
    )
    checkExit('psql', await t.exit, warnings)
    return { warnings }
  }
  needTool('pg_restore')
  const args = restoreArgs(dst.uri, opt, true)
  if (opt.mode === 'data') await truncateExisting(url, dumpTables(path), log)
  for (const s of cleanSchemas(opt)) args.push(`--schema=${s}`)
  args.push(path)
  log('restoring with pg_restore')
  const t = runTool({ name: 'pg_restore', password: dst.password, args }, log, warnings, signal)
  checkExit('pg_restore', await t.exit, warnings)
  return { warnings }
}
