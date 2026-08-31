// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `@corbits/webhook-triggers`'
// own `store.drizzle.test.ts` and this package's `migrations.test.ts`.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
//
// Proves what an in-memory `PendingSeedStore` fake cannot: that
// `createDrizzlePendingSeedStore` actually persists across separate
// connections (surviving a restart by construction — it's a real
// table, not process memory), that a real cipher's ciphertext on disk
// is not the plaintext key, that a fresh connect upserts the single
// active row per (userId, tenantId) rather than accumulating rows, and
// that a row whose stored `provider` column disagrees with the AAD its
// payload was actually sealed under (simulated here via a raw SQL
// UPDATE — the kind of tamper the application layer never produces on
// its own) fails to decrypt and is swept away rather than silently
// misattributed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
} from "@intx/crypto";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyOnboardingMigrations } from "../src/migrations";
import { dbGate } from "../../../scripts/e2e/db-gate";
import {
  createDrizzlePendingSeedStore,
  type PendingSeed,
} from "../src/pending-seed";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_onboarding_pending_seed_store_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const KEY = new Uint8Array(32).fill(9);

const SEED: PendingSeed = {
  userId: "user_1",
  tenantId: "ten_1",
  principalId: "prn_1",
  tenantDomain: "alice-user1.bench.local",
  provider: "openrouter",
  apiKey: "sk-or-v1-minted",
};

describeIfDb("createDrizzlePendingSeedStore", () => {
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
    await applyOnboardingMigrations(scratchUrl);
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

  test("a real cipher's stored payload is not the plaintext, and round-trips correctly", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const cipher = createEnvKeyCredentialCipher(KEY);
      const store = createDrizzlePendingSeedStore(db, cipher);

      await store.put(SEED);

      const [rawRow] =
        await sql`select payload from onboarding.pending_seed where user_id = ${SEED.userId} and tenant_id = ${SEED.tenantId}`;
      expect(String(rawRow?.["payload"])).not.toContain(SEED.apiKey);
      expect(String(rawRow?.["payload"])).toContain("enc:");

      const read = await store.read({
        userId: SEED.userId,
        tenantId: SEED.tenantId,
      });
      expect(read).toEqual(SEED);
    } finally {
      await sql.end();
    }
  });

  test("a noop cipher (dev/test default) round-trips as plaintext identity", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const store = createDrizzlePendingSeedStore(
        db,
        createNoopCredentialCipher(),
      );
      const seed: PendingSeed = { ...SEED, userId: "user_noop" };

      await store.put(seed);

      const [rawRow] =
        await sql`select payload from onboarding.pending_seed where user_id = ${seed.userId} and tenant_id = ${seed.tenantId}`;
      expect(String(rawRow?.["payload"])).toContain(seed.apiKey);

      const read = await store.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toEqual(seed);
    } finally {
      await sql.end();
    }
  });

  test("a fresh connect upserts the single active row per (userId, tenantId) — never a second row", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const cipher = createEnvKeyCredentialCipher(KEY);
      const store = createDrizzlePendingSeedStore(db, cipher);
      const seed: PendingSeed = { ...SEED, userId: "user_upsert" };

      await store.put(seed);
      const replacement: PendingSeed = {
        ...seed,
        provider: "huggingface",
        apiKey: "hf_replaced",
      };
      await store.put(replacement);

      const rows =
        await sql`select provider from onboarding.pending_seed where user_id = ${seed.userId} and tenant_id = ${seed.tenantId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["provider"]).toBe("huggingface");

      const read = await store.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toEqual(replacement);
    } finally {
      await sql.end();
    }
  });

  test("survives across separate connections — DB-backed, not process memory", async () => {
    const cipher = createEnvKeyCredentialCipher(KEY);
    const seed: PendingSeed = { ...SEED, userId: "user_restart" };

    const writeSql = postgres(scratchUrl, { max: 1 });
    try {
      const writeStore = createDrizzlePendingSeedStore(
        drizzle(writeSql),
        cipher,
      );
      await writeStore.put(seed);
    } finally {
      await writeSql.end();
    }

    // A brand-new connection and store instance — nothing shared with
    // the one above except the database and the cipher key, exactly
    // what survives a real hub restart.
    const readSql = postgres(scratchUrl, { max: 1 });
    try {
      const readStore = createDrizzlePendingSeedStore(drizzle(readSql), cipher);
      const read = await readStore.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toEqual(seed);
    } finally {
      await readSql.end();
    }
  });

  test("a row whose provider column disagrees with the AAD its payload was sealed under fails closed and is swept away", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const cipher = createEnvKeyCredentialCipher(KEY);
      const store = createDrizzlePendingSeedStore(db, cipher);
      const seed: PendingSeed = { ...SEED, userId: "user_tamper" };

      await store.put(seed);
      // Simulate a tamper the application layer never produces:
      // relabel the row's provider column without re-sealing the
      // payload under the new AAD.
      await sql`update onboarding.pending_seed set provider = 'huggingface' where user_id = ${seed.userId} and tenant_id = ${seed.tenantId}`;

      const read = await store.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toBeUndefined();

      const rows =
        await sql`select 1 from onboarding.pending_seed where user_id = ${seed.userId} and tenant_id = ${seed.tenantId}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("an expired row is deleted at read time, not merely skipped", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const cipher = createEnvKeyCredentialCipher(KEY);
      const store = createDrizzlePendingSeedStore(db, cipher);
      const seed: PendingSeed = { ...SEED, userId: "user_expired" };

      await store.put(seed, { ttlMs: -1 });

      const read = await store.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toBeUndefined();

      const rows =
        await sql`select 1 from onboarding.pending_seed where user_id = ${seed.userId} and tenant_id = ${seed.tenantId}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("clear deletes the row", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const db = drizzle(sql);
      const cipher = createEnvKeyCredentialCipher(KEY);
      const store = createDrizzlePendingSeedStore(db, cipher);
      const seed: PendingSeed = { ...SEED, userId: "user_clear" };

      await store.put(seed);
      await store.clear({ userId: seed.userId, tenantId: seed.tenantId });

      const read = await store.read({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      expect(read).toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});
