// DB-gated: runs against its own scratch database, never the
// developer's or the walking-skeleton suite's, mirroring
// packages/run-key-history/test/migrations.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyWorkflowDeploySourceMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_workflow_deploy_source_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("applyWorkflowDeploySourceMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(run: (sql: postgres.Sql) => Promise<void>) {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
  }, 20000);

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("creates the schema, table, and ledger on first run", async () => {
    const report = await applyWorkflowDeploySourceMigrations(scratchUrl);
    expect(report.applied).toEqual(["0001_workflow_deploy_source"]);
    expect(report.alreadyApplied).toEqual([]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'workflow_deploy_source'
        ORDER BY table_name
      `;
      expect(tables.map((row) => row["table_name"])).toEqual([
        "workflow_deploy_source",
        "workflow_deploy_source_migrations",
      ]);
    } finally {
      await sql.end();
    }
  });

  test("is idempotent: a second run applies nothing new", async () => {
    const report = await applyWorkflowDeploySourceMigrations(scratchUrl);
    expect(report.applied).toEqual([]);
    expect(report.alreadyApplied).toEqual(["0001_workflow_deploy_source"]);
  });
});

// Separate database from the suites above: two replicas racing the same
// ledger must not collide with the earlier tests' own already-applied
// rows, and must start from a schema that has never seen this migration
// set before.
describeIfDb("applyWorkflowDeploySourceMigrations concurrency", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace(
    "_workflow_deploy_source_migrations_test",
    "_workflow_deploy_source_migrations_concurrent_test",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(run: (sql: postgres.Sql) => Promise<void>) {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
  }, 20000);

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("two replicas booting concurrently both complete without either crashing on a duplicate ledger insert", async () => {
    const [first, second] = await Promise.all([
      applyWorkflowDeploySourceMigrations(scratchUrl),
      applyWorkflowDeploySourceMigrations(scratchUrl),
    ]);

    const appliedNames = [...first.applied, ...second.applied].sort();
    expect(new Set(appliedNames).size).toBe(appliedNames.length);
    expect(
      [
        ...appliedNames,
        ...first.alreadyApplied,
        ...second.alreadyApplied,
      ].sort(),
    ).toEqual(["0001_workflow_deploy_source", "0001_workflow_deploy_source"]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const ledgerRows = await sql.unsafe(
        `SELECT name FROM "workflow_deploy_source"."workflow_deploy_source_migrations" ORDER BY name`,
      );
      expect(ledgerRows.map((row) => String(row["name"]))).toEqual([
        "0001_workflow_deploy_source",
      ]);
    } finally {
      await sql.end();
    }
  }, 10000);
});
