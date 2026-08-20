// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring `migrations.test.ts`.
// Runs against its own scratch database.
//
// `reactions.test.ts` proves `toggleReaction`'s on/off contract against
// the in-memory store, which can never actually race (its body has no
// `await` between the has/set, so two "concurrent" calls just run
// sequentially on the JS event loop). This exercises the real
// `createDrizzleReactionStore` path, where two concurrent toggles for
// the same (tenant, workbench, message, emoji, principal) really do race
// at the database: proves the fix (`INSERT ... ON CONFLICT DO NOTHING`,
// never select-then-branch) never throws a raw PK-violation and always
// leaves a consistent, non-crashed final state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleReactionStore } from "../src/reactions";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_reactions_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";

describeIfDb("createDrizzleReactionStore: concurrent toggleReaction", () => {
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

  test("two concurrent toggles for the same reaction never throw a PK-violation, and settle to a consistent state", async () => {
    // `max: 5` — a real connection pool, so the two toggles below issue
    // genuinely overlapping queries rather than being serialized onto
    // one connection before either can race the other.
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleReactionStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m_race",
        emoji: "👍",
        principalId: "prn_alice",
      };

      const [first, second] = await Promise.all([
        store.toggleReaction(input),
        store.toggleReaction(input),
      ]);

      // Neither call threw. One inserted (added: true), the other saw
      // it already present and removed it (added: false) — the
      // insert-then-delete race the fix is meant to make safe, not a
      // guess about which one "wins".
      const outcomes = [first.added, second.added].sort();
      expect(outcomes).toEqual([false, true]);

      const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
        "m_race",
      ]);
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("many concurrent toggles from different principals all persist with no crash", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleReactionStore(drizzle(sql));
      const principals = ["prn_a", "prn_b", "prn_c", "prn_d", "prn_e"];

      const results = await Promise.all(
        principals.map((principalId) =>
          store.toggleReaction({
            tenantId: TENANT,
            workbenchId: WORKBENCH,
            messageId: "m_race_multi",
            emoji: "🚀",
            principalId,
          }),
        ),
      );
      expect(results.every((result) => result.added)).toBe(true);

      const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
        "m_race_multi",
      ]);
      expect(rows).toHaveLength(5);
    } finally {
      await sql.end();
    }
  });
});
