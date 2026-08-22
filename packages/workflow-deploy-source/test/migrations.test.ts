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
