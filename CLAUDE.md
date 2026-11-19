# Notes for AI coding sessions

## Commands

- Dev: `pnpm dev` (API :7800 with the token `dev-token`, web :5173 with a proxy for `/rpc`, `/api` and `/files`).
  Set `ALTIVOLA_DB_HOME` to a scratch folder so dev runs do not touch your real connections.
- CLI from source: `pnpm cli <command>`, e.g. `pnpm cli conn list`.
- Before saying something is done: `pnpm exec biome ci . && pnpm typecheck && pnpm test && pnpm build`
- After changing any procedure: `pnpm openapi` and commit `apps/api/openapi.json`.
- The image: `docker compose build`, then `docker compose up -d` (port 7789).
- Desktop app: `pnpm build`, then `pnpm --filter @app/desktop build:app` (needs Rust). The app copies the Node binary
  and `apps/api/dist` in as a sidecar and opens the server's page on 127.0.0.1:7791.
- Release: push a tag `vX.Y.Z`. CI publishes the image, then the macOS dmg and the updater files to the same GitHub
  release. The updater signing key lives in altivola/secrets (`altivola-db/release.env`); never replace it, installed
  apps only trust that key.

## Rules

- This is a local tool: it runs on the user's machine (usually in Docker) so it can reach databases behind a VPN.
  Do not add a hosted deploy. The desktop app (Tauri) only wraps the same server; keep app logic in the server and web.
- The server only answers loopback hosts and needs the per-run token on `/rpc`, `/api` and `/files`. Keep both checks
  on every new route. No CORS.
- Each database has one driver in `packages/core/src/drivers/` behind the `Driver` interface in `types.ts`. SQL
  drivers return cells as text (or null), like psql prints them. MySQL, SQLite and SQL Server share `sqldb.ts`.
- User statements run as written. Values that come from the UI (grid edits) always travel as parameters; identifiers
  are quoted with the dialect's quote function. Never build SQL from user values by joining strings.
- The mongosh parser walks an acorn AST with an allow list. Never use eval, Function or node:vm: AI agents send
  queries too.
- The read-only flag must be checked in every write path (query, apply, import, copy target).
- Every driver change gets an integration test in `packages/core/test/` against a real database (testcontainers).
  MongoDB tests use mongo:7. Cloudflare D1 has no container: its tests run a real SQLite database behind a fake of
  D1's `/raw` endpoint.
- `connections.json` keeps slimdb's format, so slimdb files import as they are.
- UI: shadcn/ui components in `apps/web/src/components/ui`, brand tokens in `packages/ui/tokens.css`. Yellow is a fill
  behind black text, never text on white.
- Docs, comments, and commit messages are in plain, simple English. No em dashes.
