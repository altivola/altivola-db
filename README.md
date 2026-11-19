# altivola-db

A slim, local database client for **PostgreSQL**, **MySQL/MariaDB**, **SQLite**, **SQL Server**, **MongoDB** and
**Redis**, with a built-in **MCP server** so AI agents (Claude Code, Claude Desktop, Cursor, and others) can query your
databases too.

It runs on your machine (best in Docker), opens in your browser and only listens on localhost. Databases you reach
over a VPN work, because the queries leave from your own machine.

It is the successor of [slimdb](https://github.com/jabbar-hafizh/slimdb), rebuilt in TypeScript, and reads slimdb's
saved connections as they are.

## Features

- **Connections** for PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, MongoDB and Redis, saved locally, with an
  optional read-only flag. A name like `team/dev/app` puts the connection in a `team` folder in the sidebar.
- **Object tree**: schemas, tables and views (SQL), databases and collections (MongoDB), databases and keys (Redis),
  with a filter.
- **Query tabs**: as many consoles as you like, each on its own connection (and MongoDB or Redis database), kept between
  sessions, with autocomplete for keywords, snippets (`sel` + Tab gives `select * from`), tables, columns (also after
  an alias, `c.`), Mongo collections, methods, fields and operators, and Redis commands.
- **Results grid**: typed column headers, sort by column, NULLs marked, JSON view for documents, copy as CSV or JSON.
  Large results scroll smoothly.
- **Edit data in the grid**: change cells, add and delete rows, then submit them in one go (one transaction on SQL
  databases).
- **Describe**: columns, indexes and constraints, or inferred fields and indexes for MongoDB.
- **Explain**, optionally with `analyze` (Postgres, MySQL and SQL Server roll the statement back).
- **History** of everything run, from the UI and from AI agents.
- **Dump and import**: dump a database to a file, import a dump file, or copy a database straight into another
  connection, e.g. dev into local (Postgres and MongoDB).
- **MCP server**: list connections, browse objects, describe, query, explain.
- **REST API** with docs at `/api`, the same one the UI uses.

## Run it with Docker

```sh
docker run -d --name altivola-db --restart unless-stopped \
  -p 127.0.0.1:7789:7789 -v altivola-db-data:/data \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/altivola/altivola-db:latest
```

or, from a clone of this repo, `docker compose up -d`. Then open http://localhost:7789.

- `localhost` in a connection URL means your machine, not the container: the image rewrites it to
  `host.docker.internal` (set `ALTIVOLA_DB_LOCALHOST_ALIAS=` to turn that off). For databases in other containers,
  use their container or service name.
- Keep the port published on `127.0.0.1` as above. Anyone who can reach the port can run queries.
- Manage connections from the terminal with `docker exec altivola-db altivola-db conn add ...`. Do not run a bare
  `docker exec altivola-db altivola-db`: with no command it starts a second server inside the container.
- MCP through the running container: `claude mcp add altivola-db -- docker exec -i altivola-db altivola-db mcp`
- The image has the PostgreSQL 18 client tools (`pg_dump`, `pg_restore`, `psql`) for dump, import and copy.
- Update: `docker compose pull && docker compose up -d`.

## Desktop app (macOS)

The desktop app runs the same server inside the app, so it needs no Docker and reaches whatever your Mac reaches,
VPN included. It keeps its data in `~/Library/Application Support/altivola-db` and listens on `127.0.0.1:7791`.

There is no signed download yet. Build it yourself (needs Rust, from https://rustup.rs):

```sh
pnpm install && pnpm build
pnpm --filter @app/desktop build:app
cp -R apps/desktop/src-tauri/target/release/bundle/macos/altivola-db.app /Applications/
```

The app is not signed, so macOS may refuse to open a copy that came from another machine. Right-click it and pick
Open, or run `xattr -dr com.apple.quarantine /Applications/altivola-db.app`.

Dump, import and copy use `pg_dump`, `pg_restore` and `psql` from your machine: `brew install libpq` (the app also
looks in Homebrew's libpq folder). To move connections from the Docker container:
`docker cp altivola-db:/data/connections.json ~/Library/Application\ Support/altivola-db/`, then change
`host.docker.internal` back to `localhost` in that file.

MCP for the desktop app: `claude mcp add altivola-db -- /Applications/altivola-db.app/Contents/MacOS/node
/Applications/altivola-db.app/Contents/Resources/server/altivola-db.js mcp`.

## Coming from slimdb

The connection file has the same format. Copy slimdb's file out of its container and import it:

```sh
docker cp slimdb:/data/connections.json ./slimdb-connections.json
docker cp ./slimdb-connections.json altivola-db:/tmp/slimdb-connections.json
docker exec altivola-db altivola-db conn import /tmp/slimdb-connections.json
rm ./slimdb-connections.json   # it holds passwords
```

MongoDB dumps made by slimdb (`.mongo.gz`) import too.

## Connection URLs

| Database        | URL                                                                       |
| --------------- | ------------------------------------------------------------------------- |
| PostgreSQL      | `postgres://postgres:secret@localhost:5432/app`                           |
| MySQL / MariaDB | `mysql://root:secret@localhost:3306/app` (`mariadb://` works too)         |
| SQLite          | `sqlite:///absolute/path/app.db` or `sqlite:app.db` (the file must exist) |
| SQL Server      | `sqlserver://sa:secret@localhost:1433?database=app`                       |
| MongoDB         | `mongodb://localhost:27017/shop`                                          |
| Redis           | `redis://:secret@localhost:6379/0` (`rediss://` for TLS)                  |

- Postgres `sslmode` works like it does in `psql`: `require` encrypts without checking the certificate.
- With Docker, a SQLite file has to be mounted into the container, e.g. `-v ~/data:/sqlite`, then use
  `sqlite:///sqlite/app.db`.

## Running queries

| Shortcut                  | Action                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Ctrl/Cmd + Enter          | Run the selection, or the block around the cursor (blocks are separated by a blank line) |
| Ctrl/Cmd + Shift + Enter  | Run the whole editor                                                                     |
| Tab                       | Accept the highlighted suggestion                                                        |
| Ctrl + Space              | Show suggestions                                                                         |
| Click a table             | Describe it                                                                              |
| Double-click a table      | Query its first 100 rows                                                                 |
| Double-click a cell       | Edit it (editable results) or show the full value                                        |
| Tab / Shift+Tab (editing) | Save the cell and edit the next one                                                      |
| Delete                    | Mark the selected row for deletion                                                       |

Results are capped by the **Limit** selector (default 500). Postgres SELECTs run through a cursor, and the other
drivers stop reading at the limit, so a query on a huge table only fetches what is shown.

### Editing data

A result is editable when its rows come from one table and include the table's primary key (for MongoDB: documents
from `find` with their `_id`). The status line then says _editable_. Double-click a cell to change it, use **+ Row**,
**− Row** and **NULL**, and **Submit** to save. Changes stay pending (highlighted) until you submit, and **Revert**
drops them. After a submit, only the statement behind the result runs again.

- SQL databases save all changes in one transaction. An update or delete that would hit more or less than exactly one
  row fails, and nothing is saved.
- MongoDB values are typed as JSON: `42`, `true`, `["a", "b"]`, `{"$date": "2026-01-01T00:00:00Z"}`. Text fields are
  edited without quotes. MongoDB has no transactions on a single server, so changes run in order and stop at the first
  failure.
- Read-only connections never show the edit buttons.

### MongoDB syntax

altivola-db understands the common mongosh forms. It parses them, it does not run JavaScript, so variables and loops
are not supported.

```js
show dbs
show collections
use shop

db.orders.find({ status: "paid" }, { items: 0 }).sort({ at: -1 }).limit(20)
db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
db.orders.countDocuments({ at: { $gte: ISODate("2026-01-01") } })
db.orders.distinct("status")
db.orders.insertOne({ item: "coffee", qty: 2 })
db.orders.updateMany({ status: "new" }, { $set: { status: "paid" } })
db.orders.deleteOne({ _id: ObjectId("65a1b2c3d4e5f60718293a4b") })
db.orders.createIndex({ at: -1 }, { name: "at_desc" })
db.getCollection("order items").find()
db.runCommand({ dbStats: 1 })
```

Helpers: `ObjectId`, `ISODate`/`new Date`, `NumberLong`, `NumberInt`, `NumberDecimal`, `UUID`, and regular
expressions like `/^ab/i`.

### Redis

One command per line, quoted like a shell: `HGETALL user:42`, `SET greeting "hello world"`. Pick the database (`db0`,
`db1`, …) in the selector next to the connection name or by clicking it in the tree; double-clicking a key reads it
with the command for its type. Redis results are not editable in the grid; use commands.

### Dump, import and copy

Pick a Postgres or MongoDB connection and click **Dump / Import…**:

- **Dump to file** downloads the database into your browser's download folder: a pg_dump custom-format `.dump` for
  Postgres (`pg_restore` reads it too), a `.mongo.gz` for MongoDB.
- **Import file** loads such a file into the selected connection. For Postgres a plain `.sql` file works too; it runs
  as it is.
- **Copy to connection** copies straight into another connection of the same kind, for example from the shared dev
  database into the one on your machine.

| Mode                 | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| Everything (default) | Schema and data. Matching tables are dropped and recreated in the target  |
| Schema only          | Tables, indexes, functions and so on, no rows                             |
| Data only            | Empties the tables that already exist in the target, then copies the rows |

- Postgres goes through `pg_dump | pg_restore` (owners and grants are left out). A missing target database is
  created. Limit the copy to some schemas with the Schemas field.
- MongoDB collections are copied with their indexes. Views are skipped.
- Statements the target cannot run, such as an extension it does not have, are reported as warnings and the copy goes
  on.
- A read-only connection is never a target. A target that is not on your machine must be confirmed by typing its name.

## Command line

```sh
altivola-db                                   # the web UI on http://127.0.0.1:7789
altivola-db conn add local-pg postgres://postgres:secret@localhost:5432/app
altivola-db conn add --read-only prod-replica postgres://readonly@replica:5432/app
altivola-db conn rename local-pg work/dev/app
altivola-db conn list
altivola-db conn import connections.json      # a slimdb or altivola-db file
altivola-db dump dev/app                      # writes dev-app-<date>.dump here
altivola-db import dev-app-20261115-1304.dump local/app
altivola-db copy dev/app local/app            # everything
altivola-db copy --mode data --schema public dev/app local/app
altivola-db mcp                               # the MCP server on stdio
```

In Docker, put `docker exec altivola-db` (or `docker exec -i` for `mcp`) in front.

## Use it with AI agents (MCP)

| Tool               | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `list_connections` | Saved connections (names and kinds, never URLs or passwords)      |
| `add_connection`   | Save a new connection after testing it                            |
| `list_objects`     | Schemas and tables, or databases and collections                  |
| `describe`         | Columns, indexes, constraints, or inferred Mongo fields           |
| `query`            | Run SQL, mongosh or Redis statements (default 100 rows, max 1000) |
| `explain`          | Query plan, optionally with analyze                               |

**Claude Code:** `claude mcp add altivola-db -- docker exec -i altivola-db altivola-db mcp`

**Claude Desktop, Cursor and other clients** (JSON config):

```json
{
  "mcpServers": {
    "altivola-db": { "command": "docker", "args": ["exec", "-i", "altivola-db", "altivola-db", "mcp"] }
  }
}
```

> **Agents can write.** The `query` tool runs whatever it is given, including `UPDATE`, `DELETE` and `drop()`. Mark a
> connection read-only (in the UI or with `conn add --read-only`) for anything you do not want an agent to change. For a
> hard guarantee, connect with a database user that only has read access.

## Where things are stored

Connections and history live in `/data` in the container (the `altivola-db-data` volume), or, when run from source, in
your user config folder under `altivola-db/` (`~/Library/Application Support` on macOS, `~/.config` on Linux,
`%AppData%` on Windows). Set `ALTIVOLA_DB_HOME` to use another folder. Connection URLs, passwords included, are stored
in plain text in `connections.json` with file mode 0600.

## Security notes

- The server only answers requests for `localhost`/loopback hosts, which blocks DNS-rebinding attacks, and every API
  call needs a random token issued per run and put in the page, which blocks other websites from calling the API
  (CSRF).
- `altivola-db serve` refuses to listen on a non-loopback address (the Docker image opts in and publishes the port on
  `127.0.0.1`).
- The read-only flag sets `default_transaction_read_only` on Postgres, a read-only session on MySQL, read-only mode on
  SQLite, and refuses writing statements on SQL Server, write methods on MongoDB and write commands on Redis. It guards
  against mistakes; it is not a security boundary.

## Development

Needs Node 24, pnpm (through corepack) and Docker.

```sh
corepack enable
pnpm install
pnpm dev        # API on :7800, web on http://localhost:5173 (Vite, proxying /rpc, /api and /files)
pnpm test       # unit tests, plus integration tests on real databases started by testcontainers
pnpm build      # apps/api/dist/altivola-db.js with the web app next to it
pnpm cli conn list
```

Set `SKIP_SQLSERVER=1` to skip the SQL Server tests on a machine that cannot run its image.

Layout:

```
packages/core   drivers (one per database), saved connections and history, grid edits,
                dump/import/copy, SQL splitter, mongosh parser
packages/api    oRPC procedures the UI and the REST API share
apps/api        the server (Hono), CLI and MCP server, bundled into one file
apps/web        the UI (React, CodeMirror, shadcn/ui)
apps/desktop    the Tauri app: runs the server with a bundled Node and shows the UI
```

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
