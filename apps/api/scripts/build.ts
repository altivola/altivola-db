// Bundles the server and CLI into one file, and puts the built web app next to
// it, so the Docker image needs no node_modules.

import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { build } from 'esbuild'

const version = process.env.VERSION || 'dev'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/altivola-db.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  define: { __VERSION__: JSON.stringify(version) },
  // Optional add-ons the drivers load only when present (native or cloud auth).
  external: [
    'pg-native',
    'kerberos',
    'snappy',
    '@mongodb-js/zstd',
    'mongodb-client-encryption',
    'gcp-metadata',
    'socks',
    'aws4',
    '@aws-sdk/credential-providers',
  ],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
})

const web = new URL('../../web/dist', import.meta.url)
await rm(new URL('../dist/web', import.meta.url), { recursive: true, force: true })
if (existsSync(web)) await cp(web, new URL('../dist/web', import.meta.url), { recursive: true })
console.info(`built dist/altivola-db.js (${version})${existsSync(web) ? ' with the web app' : ', no web app yet'}`)
