// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `reactions.drizzle.test.ts` and
// `migrations.test.ts`. Runs against its own scratch database.
//
// Proves `createDrizzleWriteClaimStore`'s race safety: two concurrent
// `tryClaim` calls for the same `(tenantId, surface, claimKey)` really do
// race at the database (a real connection pool, not one connection
// serializing them), and the fix (`INSERT ... ON CONFLICT DO NOTHING`,
// never select-then-branch) always leaves exactly one winner and never
// throws a raw PK-violation — the exact scenario CL-6039 exists to close:
// a redelivered `onTurnFinalized` racing itself across a hub restart or
// sidecar reconnect.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleWriteClaimStore } from "../src/write-claims";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_write_claims_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("createDrizzleWriteClaimStore: concurrent tryClaim", () => {
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
    await applyChatMigrations(scratchUrl);
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

  test("two concurrent claims for the same key never throw, and exactly one wins", async () => {
    // `max: 5` — a real connection pool, so the two claims below issue
    // genuinely overlapping queries rather than being serialized onto
    // one connection before either can race the other.
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleWriteClaimStore(drizzle(sql));
      const claim = {
        tenantId: "ten_1",
        surface: "memory" as const,
        claimKey: "turn_race_1",
      };

      const [first, second] = await Promise.all([
        store.tryClaim(claim),
        store.tryClaim(claim),
      ]);

      expect([first, second].sort()).toEqual([false, true]);

      const rows = await sql.unsafe(
        `SELECT * FROM "chat"."finalized_turn_write_claim" WHERE "tenant_id" = 'ten_1' AND "surface" = 'memory' AND "claim_key" = 'turn_race_1'`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("a claim already won by an earlier delivery is not won again by a later one", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleWriteClaimStore(drizzle(sql));
      const claim = {
        tenantId: "ten_1",
        surface: "artifact" as const,
        claimKey: "turn_sequential_1",
      };

      const first = await store.tryClaim(claim);
      const second = await store.tryClaim(claim);

      expect(first).toBe(true);
      expect(second).toBe(false);
    } finally {
      await sql.end();
    }
  });

  test("different surfaces for the same turn id claim independently", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleWriteClaimStore(drizzle(sql));

      const memoryClaim = await store.tryClaim({
        tenantId: "ten_1",
        surface: "memory",
        claimKey: "turn_shared_key",
      });
      const artifactClaim = await store.tryClaim({
        tenantId: "ten_1",
        surface: "artifact",
        claimKey: "turn_shared_key",
      });

      expect(memoryClaim).toBe(true);
      expect(artifactClaim).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
