// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), and turned into a loud failure
// by E2E_REQUIRED=1 so the suite can never silently vanish from CI —
// mirroring `@corbits/chat`'s own migrations test. Runs against its
// own scratch database, never the developer's or the walking-skeleton
// suite's, so a failure here can never corrupt either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyWebhookTriggersMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_webhook_triggers_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const migrationNames = [
  "0001_webhook_trigger",
  "0002_webhook_trigger_tenant_index",
  "0003_webhook_trigger_tenant_definition_name_unique",
  "0004_repo_review_lease",
];

describeIfDb("applyWebhookTriggersMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
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

  test("applies the trigger table into its own schema and is idempotent on a second run", async () => {
    const first = await applyWebhookTriggersMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyWebhookTriggersMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'webhook_triggers' AND table_name = 'webhook_trigger'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "webhook_trigger",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT 1 FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'webhook_trigger'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});

// Separate database from the suite above: two replicas racing the same
// ledger must not collide with the idempotency test's own already-applied
// rows, and must start from a schema that has never seen this migration
// set before.
describeIfDb("applyWebhookTriggersMigrations concurrency", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace(
    "_webhook_triggers_migrations_test",
    "_webhook_triggers_migrations_concurrent_test",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

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

  test("two replicas booting concurrently both complete without either crashing on a duplicate ledger insert", async () => {
    const [first, second] = await Promise.all([
      applyWebhookTriggersMigrations(scratchUrl),
      applyWebhookTriggersMigrations(scratchUrl),
    ]);

    const appliedNames = [...first.applied, ...second.applied].sort();
    expect(new Set(appliedNames).size).toBe(appliedNames.length);
    expect(
      [
        ...appliedNames,
        ...first.alreadyApplied,
        ...second.alreadyApplied,
      ].sort(),
    ).toEqual(migrationNames.flatMap((name) => [name, name]).sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const ledgerRows = await sql.unsafe(
        `SELECT name FROM "webhook_triggers"."webhook_triggers_migrations" ORDER BY name`,
      );
      expect(ledgerRows.map((row) => String(row["name"]))).toEqual(
        migrationNames,
      );
    } finally {
      await sql.end();
    }
  }, 10000);
});
