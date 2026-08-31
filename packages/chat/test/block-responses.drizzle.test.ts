// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `write-claims.drizzle.test.ts`.
// Runs against its own scratch database.
//
// Proves `createDrizzleBlockResponseStore`'s notification claim is
// race-safe against a real Postgres connection pool (not one connection
// serializing two concurrent calls) — the exact scenario CL-7192 exists
// to close: a changed answer or a double-click racing the original
// submission for the same (tenant, workbench, message, block, principal),
// where the in-memory store's single-threaded tests can't exercise a real
// lock/serialization path the production store depends on.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleBlockResponseStore } from "../src/block-responses";
import type { BlockResponseKey } from "../src/block-responses";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_block_responses_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb(
  "createDrizzleBlockResponseStore: concurrent notification claim",
  () => {
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
      } finally {
        await maintenance.end();
      }
    });

    function keyFor(claimKey: string): BlockResponseKey {
      return {
        tenantId: "ten_1",
        workbenchId: "run_1",
        messageId: "m1",
        blockId: "blk_question1",
        principalId: claimKey,
      };
    }

    test("two concurrent claims for the same key never throw, and exactly one wins", async () => {
      // `max: 5` — a real connection pool, so the two claims below issue
      // genuinely overlapping queries rather than being serialized onto
      // one connection before either can race the other.
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleBlockResponseStore(drizzle(sql));
        const key = keyFor("prn_race_1");
        await store.upsertBlockResponse({
          ...key,
          payload: { kind: "question", answer: "Staging" },
        });

        const [first, second] = await Promise.all([
          store.claimBlockResponseNotification(key),
          store.claimBlockResponseNotification(key),
        ]);

        const outcomes = [first, second];
        expect(outcomes.filter((outcome) => outcome !== false)).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === false)).toHaveLength(1);

        const rows = await sql.unsafe(
          `SELECT "notified_at", "notification_claim_token" FROM "chat"."block_responses" WHERE "tenant_id" = 'ten_1' AND "workbench_id" = 'run_1' AND "message_id" = 'm1' AND "block_id" = 'blk_question1' AND "principal_id" = 'prn_race_1'`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.notified_at).not.toBeNull();
        expect(rows[0]?.notification_claim_token).toBe(
          outcomes.find((outcome) => outcome !== false),
        );
      } finally {
        await sql.end();
      }
    });

    test("a claim already won is not won again by a later call", async () => {
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleBlockResponseStore(drizzle(sql));
        const key = keyFor("prn_sequential_1");
        await store.upsertBlockResponse({
          ...key,
          payload: { kind: "question", answer: "Staging" },
        });

        const first = await store.claimBlockResponseNotification(key);
        const second = await store.claimBlockResponseNotification(key);

        expect(typeof first).toBe("string");
        expect(second).toBe(false);
      } finally {
        await sql.end();
      }
    });

    test("release with the holder's own token frees the claim for a fresh claim", async () => {
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleBlockResponseStore(drizzle(sql));
        const key = keyFor("prn_release_1");
        await store.upsertBlockResponse({
          ...key,
          payload: { kind: "question", answer: "Staging" },
        });

        const token = await store.claimBlockResponseNotification(key);
        expect(token).not.toBe(false);
        await store.releaseBlockResponseNotification(key, token as string);

        const reclaimed = await store.claimBlockResponseNotification(key);
        expect(reclaimed).not.toBe(false);
      } finally {
        await sql.end();
      }
    });

    test("release with a stale token never evicts a live claim", async () => {
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleBlockResponseStore(drizzle(sql));
        const key = keyFor("prn_stale_token_1");
        await store.upsertBlockResponse({
          ...key,
          payload: { kind: "question", answer: "Staging" },
        });

        const firstToken = await store.claimBlockResponseNotification(key);
        expect(firstToken).not.toBe(false);
        await store.releaseBlockResponseNotification(key, firstToken as string);
        const secondToken = await store.claimBlockResponseNotification(key);
        expect(secondToken).not.toBe(false);
        expect(secondToken).not.toBe(firstToken);

        // The first (now stale) token must never release the second,
        // currently-live claim.
        await store.releaseBlockResponseNotification(key, firstToken as string);
        const thirdAttempt = await store.claimBlockResponseNotification(key);
        expect(thirdAttempt).toBe(false);
      } finally {
        await sql.end();
      }
    });
  },
);
