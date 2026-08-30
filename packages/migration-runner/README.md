# @corbits/migration-runner

Shared mechanics for the "transactional, self-contained" package migration
shape documented in [docs/package-migrations.md](../../docs/package-migrations.md):
schema and ledger bootstrap, a per-migration `sql.begin` transaction, and a
session-level Postgres advisory lock held around the whole run.

## Why the lock

Every caller opens its own single-connection (`max: 1`) client and calls
`applyPackageMigrations` at hub boot. With two hub replicas booting at once,
both would otherwise `SELECT` the ledger before either had inserted a row,
both would see "not yet applied," and the loser's ledger `INSERT` would
violate the ledger table's primary key and crash that replica's boot.
`applyPackageMigrations` takes `pg_advisory_lock(hashtext(ledgerTable))`
immediately after connecting and holds it — across every migration's own
transaction — until the run finishes, releasing it in a `finally` before the
connection closes. The loser blocks until the winner finishes, then re-checks
the ledger and finds every migration already applied. Postgres also releases
a session-level advisory lock automatically if the holding connection dies,
so a crashed replica never wedges the lock for the next boot.

The lock key is derived from the ledger table name, which is already unique
per package (`bench_migrations`, `insights_migrations`, ...), so distinct
packages never contend on the same lock.

## What it does not change

Each migration still applies and records itself in its own transaction, and
a failure still wraps and rethrows as `` `${packageLabel} migration ${name}
failed: ...` `` with the original error as `cause` — this package only closes
the race around the check-and-insert, not the per-migration failure
semantics packages already relied on.

## Usage

```ts
import { applyPackageMigrations } from "@corbits/migration-runner";

export async function applyBenchMigrations(databaseUrl: string) {
  return applyPackageMigrations({
    databaseUrl,
    schema: "bench",
    ledgerTable: "bench_migrations",
    migrations: benchMigrations,
    packageLabel: "bench",
  });
}
```
