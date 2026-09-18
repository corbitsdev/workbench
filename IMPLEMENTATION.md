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

## Deployment

Deployment mechanics are not yet settled:

- Target hosting platform and process topology (one hub, how many
  sidecars, where they run) are undecided. Sidecars run as child
  processes of the hub; there is no other provisioner backend.
- Secrets management for `CREDENTIAL_ENCRYPTION_KEY` and
  `PRINCIPAL_KEY_ENCRYPTION_KEY` in a real deployment is undecided.
- Migration/rollout ordering across `hub`, `sidecar`, and `web` on deploy
  is undecided.
- Backup/restore for `HUB_DATA_DIR` and the database is undecided.

Do not assume any of the above from this document alone.
