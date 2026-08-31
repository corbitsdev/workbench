// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `@workbench/onboarding`'s own
// `pending-seed-store.drizzle.test.ts`. Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's.
//
// Proves what the in-memory fake cannot: that
// `createDrizzleAccessPolicyStore` actually persists across separate
// connections, that an upsert replaces rather than duplicates the
// single policy row per tenant, and that the real migrations produce a
// schema the store's queries actually run against.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyAccessPolicyMigrations } from "../src/migrations";
import { createDrizzleAccessPolicyStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_access_policy_store_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("createDrizzleAccessPolicyStore", () => {
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
    await applyAccessPolicyMigrations(scratchUrl);
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

  test("getPolicy on a tenant with no row returns closed defaults", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      const policy = await store.getPolicy("tnt_none");
      expect(policy).toEqual({
        selfSignup: "off",
        allowedDomains: [],
        tenancyCreation: "owners",
      });
      expect(await store.hasPolicyRow("tnt_none")).toBe(false);
    } finally {
      await sql.end();
    }
  });

  test("upsertPolicy inserts, then updates the same row rather than duplicating it", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      await store.upsertPolicy("tnt_upsert", {
        selfSignup: "allowed-domains",
        allowedDomains: ["acme.example"],
      });
      await store.upsertPolicy("tnt_upsert", { tenancyCreation: "none" });

      const rows =
        await sql`select self_signup, allowed_domains, tenancy_creation from access_policy.policy where tenant_id = 'tnt_upsert'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["self_signup"]).toBe("allowed-domains");
      expect(rows[0]?.["tenancy_creation"]).toBe("none");
      expect(JSON.parse(String(rows[0]?.["allowed_domains"]))).toEqual([
        "acme.example",
      ]);

      const policy = await store.getPolicy("tnt_upsert");
      expect(policy).toEqual({
        selfSignup: "allowed-domains",
        allowedDomains: ["acme.example"],
        tenancyCreation: "none",
      });
      expect(await store.hasPolicyRow("tnt_upsert")).toBe(true);
    } finally {
      await sql.end();
    }
  });

  test("persists across separate connections", async () => {
    const writeSql = postgres(scratchUrl, { max: 1 });
    try {
      const writeStore = createDrizzleAccessPolicyStore(drizzle(writeSql));
      await writeStore.upsertPolicy("tnt_restart", { selfSignup: "open" });
    } finally {
      await writeSql.end();
    }

    const readSql = postgres(scratchUrl, { max: 1 });
    try {
      const readStore = createDrizzleAccessPolicyStore(drizzle(readSql));
      const policy = await readStore.getPolicy("tnt_restart");
      expect(policy.selfSignup).toBe("open");
    } finally {
      await readSql.end();
    }
  });

  test("pending invites: exact-email match is found and consumption sticks", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      const invite = await store.createPendingInvite("tnt_invites", {
        matchType: "email",
        value: "Person@Acme.Example",
      });

      const match = await store.findMatchingPendingInvite(
        "person@acme.example",
      );
      expect(match?.id).toBe(invite.id);

      const won = await store.consumePendingInvite(invite.id);
      expect(won).toBe(true);
      const afterConsume = await store.findMatchingPendingInvite(
        "person@acme.example",
      );
      expect(afterConsume).toBeUndefined();
    } finally {
      await sql.end();
    }
  });

  test("consumePendingInvite is atomic: two concurrent consumers of the same row, exactly one wins", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      const invite = await store.createPendingInvite("tnt_race", {
        matchType: "email",
        value: "racer@acme.example",
      });

      const results = await Promise.all([
        store.consumePendingInvite(invite.id),
        store.consumePendingInvite(invite.id),
        store.consumePendingInvite(invite.id),
      ]);

      expect(results.filter((won) => won)).toHaveLength(1);
      expect(results.filter((won) => !won)).toHaveLength(2);

      const rows =
        await sql`select consumed_at from access_policy.pending_invite where id = ${invite.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["consumed_at"]).not.toBeNull();
    } finally {
      await sql.end();
    }
  });

  test("upsertPolicy is atomic: two concurrent patches to different fields on an existing row both land, neither reverts the other", async () => {
    const setupSql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(setupSql));
      await store.upsertPolicy("tnt_race_existing", {
        selfSignup: "off",
        allowedDomains: [],
        tenancyCreation: "owners",
      });
    } finally {
      await setupSql.end();
    }

    // A plain `Promise.all` of two real calls does not reliably force
    // the worst-case interleaving on a fast local connection: one
    // call's whole read-modify-write often finishes before the other's
    // read even starts, so the two never actually overlap. Instead, a
    // third connection takes the row's lock first and holds it open
    // while both real `upsertPolicy` calls start and queue up behind
    // it — releasing it then guarantees both calls' reads had to
    // happen without seeing the other's write yet, exactly the
    // interleaving that silently reverted one admin's change.
    const holderSql = postgres(scratchUrl, { max: 1 });
    const sqlA = postgres(scratchUrl, { max: 1 });
    const sqlB = postgres(scratchUrl, { max: 1 });
    try {
      const storeA = createDrizzleAccessPolicyStore(drizzle(sqlA));
      const storeB = createDrizzleAccessPolicyStore(drizzle(sqlB));

      let holderReady: () => void = () => undefined;
      const holderHasLock = new Promise<void>((resolve) => {
        holderReady = resolve;
      });
      let releaseHolder: () => void = () => undefined;
      const releaseSignal = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holderTx = holderSql.begin(async (tx) => {
        await tx`select * from access_policy.policy where tenant_id = 'tnt_race_existing' for update`;
        holderReady();
        await releaseSignal;
      });

      await holderHasLock;

      const racers = Promise.all([
        storeA.upsertPolicy("tnt_race_existing", { selfSignup: "open" }),
        storeB.upsertPolicy("tnt_race_existing", {
          allowedDomains: ["acme.example"],
        }),
      ]);
      // Give both calls time to actually issue their row-locking read
      // and start queuing behind the holder before it releases.
      await new Promise((resolve) => setTimeout(resolve, 100));

      releaseHolder();
      await holderTx;
      await racers;

      const policy = await storeA.getPolicy("tnt_race_existing");
      expect(policy.selfSignup).toBe("open");
      expect(policy.allowedDomains).toEqual(["acme.example"]);
      expect(policy.tenancyCreation).toBe("owners");
    } finally {
      await holderSql.end();
      await sqlA.end();
      await sqlB.end();
    }
  });

  test("upsertPolicy is atomic: two concurrent first-writes for a brand-new tenant both land, neither reverts the other", async () => {
    const sql = postgres(scratchUrl, { max: 5 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));

      // No row exists yet for this tenant, so both calls race the
      // create path too — the ensure-row-then-lock step inside
      // `upsertPolicy` has to serialize this case as well, not only
      // the existing-row case above.
      await Promise.all([
        store.upsertPolicy("tnt_race_new", { selfSignup: "open" }),
        store.upsertPolicy("tnt_race_new", {
          allowedDomains: ["acme.example"],
        }),
      ]);

      const policy = await store.getPolicy("tnt_race_new");
      expect(policy.selfSignup).toBe("open");
      expect(policy.allowedDomains).toEqual(["acme.example"]);

      const rows =
        await sql`select count(*)::int as count from access_policy.policy where tenant_id = 'tnt_race_new'`;
      expect(rows[0]?.["count"]).toBe(1);
    } finally {
      await sql.end();
    }
  });

  test("pending invites: a domain match is found for any email on that domain", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      await store.createPendingInvite("tnt_domain_invites", {
        matchType: "domain",
        value: "@Widgets.Example",
      });

      const matchOne = await store.findMatchingPendingInvite(
        "alice@widgets.example",
      );
      const matchTwo = await store.findMatchingPendingInvite(
        "bob@widgets.example",
      );
      expect(matchOne?.tenantId).toBe("tnt_domain_invites");
      expect(matchTwo?.tenantId).toBe("tnt_domain_invites");

      const noMatch = await store.findMatchingPendingInvite(
        "carol@other.example",
      );
      expect(noMatch).toBeUndefined();
    } finally {
      await sql.end();
    }
  });

  test("deletePendingInvite only removes the row for its own tenant", async () => {
    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const store = createDrizzleAccessPolicyStore(drizzle(sql));
      const invite = await store.createPendingInvite("tnt_delete_a", {
        matchType: "email",
        value: "someone@acme.example",
      });

      await store.deletePendingInvite("tnt_delete_b", invite.id);
      expect(
        await store.findMatchingPendingInvite("someone@acme.example"),
      ).toBeDefined();

      await store.deletePendingInvite("tnt_delete_a", invite.id);
      expect(
        await store.findMatchingPendingInvite("someone@acme.example"),
      ).toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});
