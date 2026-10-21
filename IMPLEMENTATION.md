# Implementation

## Stack

TypeScript throughout, run on [Bun](https://bun.sh). Hono for HTTP routes,
Postgres (with pgvector) as the database, Drizzle as the query builder.
The web client is React. arktype validates every trust boundary — env,
request bodies, external data. `oxlint`/`oxfmt` lint and format; `bun run
check` (typecheck, lint, fmt check, test) is the one gate CI runs.

## Database

The platform schema (`public`) comes entirely from `@intx/db`'s own
migrations — this repo authors no SQL for it. Every package that owns
product tables gets its own Postgres schema and one literal-SQL migration,
every statement `IF NOT EXISTS` so it needs no ledger table; the hub
applies the platform's migrations and then each mounted package's own,
in an explicit order, once at boot (`apps/hub/src/migrate.ts`).
`scripts/db-setup.ts` just creates the database if missing and calls the
same function. Custom tables are hard-removed when retired — no drop
migrations, no dead columns kept around; a schema cutover means resetting
the local database, not writing a data migration.

## Vendoring

`vendor/intx` holds Interchange packages this repo needs at a newer
commit than is published to npm. Each is a hand copy, never a submodule
or a fork, with a kill date and ledger row in [VENDORED.md](VENDORED.md).
The upstream repository is read-only from here — a needed change lands
upstream first, then gets re-vendored.

## Tool packages

Every tool package exposes Interchange's `sidecar-bundle` entry, a
synchronous `defineTool` factory the sidecar constructs at agent
creation. `@corbits/mcp/sidecar-bundle` takes the stored catalog as
config, so it needs no network at construction; `@corbits/mcp/hub` mounts
`POST /api/tenants/:t/mcp/discover`. `packages/deferred-tools` ships the
`tool_search` tool and the director; the worker's deploy pushes a second
`directors.js` bundle beside `workflow.js` and declares it in the pushed
package.json. Local Ollama models: qwen2.5:14b searches and calls
surfaced tools, qwen2.5:7b does not, so deferral needs 14b or better.

## Deployment

The root `Dockerfile` builds a single-origin production image on `oven/bun:1.4.2`: it installs workspace dependencies, builds `apps/web` (which also bundles `@corbits/worker`), sets `WEB_DIST_DIR=/app/apps/web/dist`, and starts `apps/hub/src/index.ts` on port `3000`. When `WEB_DIST_DIR` (or `PORTAL_DIR`) is set, the hub serves the compiled web bundle and SPA fallback alongside `/api/*`, `/status`, and `/openapi.json`, and derives `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` from `DATABASE_URL`. Sidecars run as child processes of the hub (`apps/sidecar/src/index.ts`) with durable state under `HUB_DATA_DIR`.

`compose.yml` pairs that image with `pgvector/pgvector:pg17` and persistent volumes for Postgres and `HUB_DATA_DIR`. See [docs/SELF_HOST.md](docs/SELF_HOST.md) for Docker Compose, cloud container hosts, required secrets, and backups.
