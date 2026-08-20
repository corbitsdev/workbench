// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/insights' migrations test.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyInferenceCatalogMigrations } from "../src/migrations";
import { createPostgresBenchModelPolicyStore } from "../src/pg-store";
import { EMPTY_POLICY } from "../src/policy";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_inference_catalog_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const migrationNames = ["0001_bench_model_policy"];

describeIfDb("applyInferenceCatalogMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(
    run: (sql: ReturnType<typeof postgres>) => Promise<void>,
  ): Promise<void> {
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

  test("creates the policy table in its own schema and is idempotent", async () => {
    const first = await applyInferenceCatalogMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyInferenceCatalogMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(migrationNames);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'inference_catalog'`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "bench_model_policy",
        "inference_catalog_migrations",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'bench_model_policy'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  }, 20000);

  test("a bench with no row reads as unconstrained, and a patch round-trips", async () => {
    await applyInferenceCatalogMigrations(scratchUrl);
    const { store, close } = createPostgresBenchModelPolicyStore(scratchUrl);
    try {
      expect(await store.getPolicy("bench-never-set")).toEqual(EMPTY_POLICY);

      await store.patchPolicy("bench-1", {
        deny: ["provider:pricey"],
        maxInputUsdPerMTok: 2.5,
        conceptCeilings: { "cheap-loop": { maxInputUsdPerMTok: 0.5 } },
        providerPreference: { mode: "prefer", order: ["anthropic"] },
      });
      const patched = await store.patchPolicy("bench-1", {
        ceilingIsHard: true,
      });

      expect(patched.deny).toEqual(["provider:pricey"]);
      expect(patched.maxInputUsdPerMTok).toBe(2.5);
      expect(patched.ceilingIsHard).toBe(true);
      expect(await store.getPolicy("bench-1")).toEqual(patched);
    } finally {
      await close();
    }
  }, 20000);
});
