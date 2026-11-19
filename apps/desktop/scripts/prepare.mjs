// Puts what the desktop app runs next to src-tauri: the Node binary (as the
// sidecar, named with the Rust target) and the built server with its web UI.
// Run `pnpm build` at the repo root first.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tauri = join(here, '..', 'src-tauri')
const dist = join(here, '..', '..', 'api', 'dist')

if (!existsSync(join(dist, 'altivola-db.js'))) {
  throw new Error('apps/api/dist/altivola-db.js is missing: run `pnpm build` at the repo root first')
}

const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
if (!host) throw new Error('could not read the Rust target from `rustc -vV`')
const ext = process.platform === 'win32' ? '.exe' : ''

mkdirSync(join(tauri, 'binaries'), { recursive: true })
const node = join(tauri, 'binaries', `node-${host}${ext}`)
copyFileSync(process.execPath, node)
chmodSync(node, 0o755)

const server = join(tauri, 'server')
rmSync(server, { recursive: true, force: true })
mkdirSync(server, { recursive: true })
copyFileSync(join(dist, 'altivola-db.js'), join(server, 'altivola-db.js'))
cpSync(join(dist, 'web'), join(server, 'web'), { recursive: true })

console.info(`sidecar ready: Node ${process.version} for ${host}, server from apps/api/dist`)
