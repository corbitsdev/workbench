// Shared mechanics for the "transactional, self-contained" package
// migration shape in docs/package-migrations.md: schema/ledger bootstrap,
// per-migration transactional apply, and a session-level advisory lock
// held around the whole run so concurrent hub replicas can't both see a
// migration as unapplied and race its ledger insert. See README.md for
// why the lock is session-level rather than per-transaction.
import { getLogger } from "@intx/log";
import postgres from "postgres";

const log = getLogger(["migration-runner"]);

export interface PackageMigration {
  name: string;
  sql: string;
}

export interface ApplyPackageMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export interface ApplyPackageMigrationsOptions {
  databaseUrl: string;
  schema: string;
  ledgerTable: string;
  migrations: readonly PackageMigration[];
  packageLabel: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export async function applyPackageMigrations(
  options: ApplyPackageMigrationsOptions,
): Promise<ApplyPackageMigrationsReport> {
  const { databaseUrl, schema, ledgerTable, migrations, packageLabel } =
    options;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  let holdsLock = false;
  try {
    log.info`waiting for the ${packageLabel} migration lock (${ledgerTable})`;
    await sql.unsafe(`SELECT pg_advisory_lock(hashtext($1)::bigint)`, [
      ledgerTable,
    ]);
    holdsLock = true;

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(schema, ledgerTable)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const existing = await sql.unsafe(
        `SELECT 1 FROM ${quoteQualified(schema, ledgerTable)} WHERE name = $1`,
        [migration.name],
      );
      if (existing.length > 0) {
        alreadyApplied.push(migration.name);
        continue;
      }
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO ${quoteQualified(schema, ledgerTable)} (name) VALUES ($1)`,
            [migration.name],
          );
        });
        applied.push(migration.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${packageLabel} migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    try {
      if (holdsLock) {
        await sql.unsafe(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [
          ledgerTable,
        ]);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
