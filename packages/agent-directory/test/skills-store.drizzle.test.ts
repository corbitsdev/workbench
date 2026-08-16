// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/config-profiles' own
// store.drizzle.test.ts. Exercises the real
// `createDrizzleDefinitionSkillsStore` path against Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyAgentDirectoryMigrations } from "../src/migrations";
import { createDrizzleDefinitionSkillsStore } from "../src/skills-store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_agent_directory_skills_store_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("createDrizzleDefinitionSkillsStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
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
    await applyAgentDirectoryMigrations(scratchUrl);
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

  test("a definition with no row yet reads as no skills attached", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleDefinitionSkillsStore(drizzle(sql));
      expect(await store.getSkills("asset_never_written")).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  test("setSkills then getSkills round-trips through real Postgres", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleDefinitionSkillsStore(drizzle(sql));
      await store.setSkills("asset_1", ["web-research", "long-form-write"]);
      expect(await store.getSkills("asset_1")).toEqual([
        "web-research",
        "long-form-write",
      ]);
    } finally {
      await sql.end();
    }
  });

  test("setSkills on an existing asset id upserts rather than duplicating", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleDefinitionSkillsStore(drizzle(sql));
      await store.setSkills("asset_2", ["research"]);
      await store.setSkills("asset_2", []);
      expect(await store.getSkills("asset_2")).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
