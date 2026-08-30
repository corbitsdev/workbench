// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `store.drizzle.test.ts`. Runs against its own scratch database.
//
// CL-7242: proves the actual compare-and-swap `acquire` relies on —
// concurrent callers racing the same (tenant, repo), a stale lease
// being stolen, and a released lease being immediately reacquirable —
// against a real Postgres. A mocked port proves nothing about
// `ON CONFLICT ... DO UPDATE ... WHERE`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { applyWebhookTriggersMigrations } from "../src/migrations";
import { createDrizzleRepoReviewLeaseStore } from "../src/repo-review-lease";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_repo_review_lease_drizzle_test`;
  return url.toString();
}

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = databaseUrl === "" ? describe.skip : describe;

const TENANT_ID = "tnt_1";

describeIfDb("createDrizzleRepoReviewLeaseStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl || "postgres://localhost:5432/unused",
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
    await applyWebhookTriggersMigrations(scratchUrl);
  });

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
  });

  test("two concurrent acquire() calls for the same tenant/repo settle on exactly one winner", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRepoReviewLeaseStore(db);

      const results = await Promise.all([
        store.acquire(TENANT_ID, "acme/widgets"),
        store.acquire(TENANT_ID, "acme/widgets"),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);

      const rows = await sql`
        select id from webhook_triggers.repo_review_lease
        where tenant_id = ${TENANT_ID} and repo = 'acme/widgets'
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("a stale lease can be stolen by a new acquire()", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRepoReviewLeaseStore(db);

      expect(await store.acquire(TENANT_ID, "acme/stale-repo")).toBe(true);

      // Backdate the lease well past the staleness window, simulating
      // a holder that crashed mid-work and never released it.
      await sql`
        update webhook_triggers.repo_review_lease
        set leased_at = now() - interval '10 minutes'
        where tenant_id = ${TENANT_ID} and repo = 'acme/stale-repo'
      `;

      expect(await store.acquire(TENANT_ID, "acme/stale-repo")).toBe(true);

      const rows = await sql`
        select id from webhook_triggers.repo_review_lease
        where tenant_id = ${TENANT_ID} and repo = 'acme/stale-repo'
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("a fresh lease cannot be stolen", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRepoReviewLeaseStore(db);

      expect(await store.acquire(TENANT_ID, "acme/fresh-repo")).toBe(true);
      expect(await store.acquire(TENANT_ID, "acme/fresh-repo")).toBe(false);
    } finally {
      await sql.end();
    }
  });

  test("release() lets an immediate reacquire succeed without waiting out the staleness window", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRepoReviewLeaseStore(db);

      expect(await store.acquire(TENANT_ID, "acme/released-repo")).toBe(true);
      await store.release(TENANT_ID, "acme/released-repo");

      const rows = await sql`
        select id from webhook_triggers.repo_review_lease
        where tenant_id = ${TENANT_ID} and repo = 'acme/released-repo'
      `;
      expect(rows).toHaveLength(0);

      expect(await store.acquire(TENANT_ID, "acme/released-repo")).toBe(true);
    } finally {
      await sql.end();
    }
  });

  test("release() on a lease this caller never held is a no-op", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRepoReviewLeaseStore(db);
      await expect(
        store.release(TENANT_ID, "acme/never-leased"),
      ).resolves.toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});
