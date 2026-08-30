// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring the six package migration test
// suites this runner replaces the mechanics of. Runs against its own
// scratch database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyPackageMigrations, type PackageMigration } from "../src/index";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_migration_runner_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "migration_runner_test";
const LEDGER_TABLE = "migration_runner_test_migrations";

const migrations: readonly PackageMigration[] = [
  {
    name: "0001_widget",
    sql: `
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."widget" (
        "id" text PRIMARY KEY
      );
    `,
  },
  {
    name: "0002_widget_label",
    sql: `
      ALTER TABLE "${SCHEMA}"."widget"
        ADD COLUMN IF NOT EXISTS "label" text;
    `,
  },
];

describeIfDb("applyPackageMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenanceConnection<T>(
    run: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      return await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenanceConnection(async (maintenance) => {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
  }, 20000);

  afterAll(async () => {
    await withMaintenanceConnection(async (maintenance) => {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("applies migrations into the package schema and is idempotent on a second run", async () => {
    const first = await applyPackageMigrations({
      databaseUrl: scratchUrl,
      schema: SCHEMA,
      ledgerTable: LEDGER_TABLE,
      migrations,
      packageLabel: "migration-runner-test",
    });
    expect(first.applied).toEqual(["0001_widget", "0002_widget_label"]);
    expect(first.alreadyApplied).toEqual([]);

    const second = await applyPackageMigrations({
      databaseUrl: scratchUrl,
      schema: SCHEMA,
      ledgerTable: LEDGER_TABLE,
      migrations,
      packageLabel: "migration-runner-test",
    });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual(
      ["0001_widget", "0002_widget_label"].sort(),
    );
  });

  test("two replicas booting concurrently both complete without either crashing on a duplicate ledger insert", async () => {
    const concurrentSchema = `${SCHEMA}_concurrent`;
    const concurrentLedger = `${LEDGER_TABLE}_concurrent`;
    const options = {
      databaseUrl: scratchUrl,
      schema: concurrentSchema,
      ledgerTable: concurrentLedger,
      migrations,
      packageLabel: "migration-runner-concurrent-test",
    };

    const [first, second] = await Promise.all([
      applyPackageMigrations(options),
      applyPackageMigrations(options),
    ]);

    const appliedNames = [...first.applied, ...second.applied].sort();
    const alreadyAppliedNames = [
      ...first.alreadyApplied,
      ...second.alreadyApplied,
    ].sort();

    expect(new Set(appliedNames).size).toBe(appliedNames.length);
    expect([...appliedNames, ...alreadyAppliedNames].sort()).toEqual(
      [...migrations, ...migrations].map((migration) => migration.name).sort(),
    );

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const ledgerRows = await sql.unsafe(
        `SELECT name FROM "${concurrentSchema}"."${concurrentLedger}" ORDER BY name`,
      );
      expect(ledgerRows.map((row) => String(row["name"]))).toEqual([
        "0001_widget",
        "0002_widget_label",
      ]);
    } finally {
      await sql.end();
    }
  });

  test("recovers the lock after the holding connection dies without releasing it", async () => {
    const crashSchema = `${SCHEMA}_crash`;
    const crashLedger = `${LEDGER_TABLE}_crash`;

    const holder = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    await holder.unsafe(`SELECT pg_advisory_lock(hashtext($1)::bigint)`, [
      crashLedger,
    ]);
    await holder.end({ timeout: 0 });

    const result = await applyPackageMigrations({
      databaseUrl: scratchUrl,
      schema: crashSchema,
      ledgerTable: crashLedger,
      migrations,
      packageLabel: "migration-runner-crash-test",
    });

    expect(result.applied).toEqual(["0001_widget", "0002_widget_label"]);
  }, 10000);
});
