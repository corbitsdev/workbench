// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), and turned into a loud failure
// by CI=true so the suite can never silently vanish from CI.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's, so a failure here can never corrupt either.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../test/database-url";
import { applyWebhookTriggersMigrations } from "../src/migrations";
import { dbGate } from "../../../test/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_webhook_triggers_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("applyWebhookTriggersMigrations", () => {
  const scratchUrl = scratchUrlFor(databaseUrl ?? "postgres://localhost:5432/unused");
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("applies the trigger table into its own schema and is idempotent on a second run, even concurrently", async () => {
    await applyWebhookTriggersMigrations(scratchUrl);
    await Promise.all([
      applyWebhookTriggersMigrations(scratchUrl),
      applyWebhookTriggersMigrations(scratchUrl),
    ]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'webhook_triggers' AND table_name = 'webhook_trigger'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual(["webhook_trigger"]);

      const inPublic = await sql.unsafe(
        `SELECT 1 FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'webhook_trigger'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  }, 20000);
});
