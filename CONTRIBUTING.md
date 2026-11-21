# Contributing

Thanks for helping out.

1. Follow the Development section in docs/guide.md to run the app locally.
2. Make your change on a branch. Keep pull requests small and focused on one thing.
3. Run the same checks as CI before you push:

   ```sh
   pnpm exec biome ci . && pnpm typecheck && pnpm test && pnpm build
   ```
4. If you changed an API procedure, run `pnpm openapi` and commit the updated `apps/api/openapi.json`.
5. Use conventional commit messages, for example `feat: describe Redis streams` or `fix: keep the MySQL session after a cut result`.

Driver changes need an integration test in `packages/core/test/` against a real database (testcontainers starts it). See `CLAUDE.md` for the project rules.
