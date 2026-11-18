import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The dev server (pnpm dev) runs the API on :7800 with a fixed token.
const api = process.env.API_URL ?? 'http://127.0.0.1:7800'

// In dev the page comes from Vite, so put the dev token in it. A build keeps
// the placeholder, which the server fills with its per-run token.
const devToken = (): Plugin => ({
  name: 'altivola-db-dev-token',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace('%ALTIVOLA_DB_TOKEN%', process.env.ALTIVOLA_DB_TOKEN ?? 'dev-token'),
})

export default defineConfig({
  envDir: '../..',
  plugins: [react(), tailwindcss(), devToken()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: { '/api': api, '/rpc': api, '/files': api },
  },
})
