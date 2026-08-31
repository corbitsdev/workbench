// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `@corbits/folded-runs`'s `scope-routes.drizzle.test.ts`. Runs the
// real platform schema (`@intx/db`'s `runMigrations`) alongside this
// package's own `applyRunKeyHistoryMigrations`, so the reconnect
// repair is proven against a real `workflow_run` row and a real
// `run_key_history` table, not a hand-rolled fake `db`.
//
// This is the crash-loop case CL-6281 exists to fix: a fresh keypair's
// `agent.deploy.ack` lands (this package records it) but the hub goes
// down before vendor's own `UPDATE workflow_run SET public_key` for
// that same ack commits. Every later reconnect challenges against the
// now-stale `workflow_run` row and fails forever. `lookupRunKeyHistoryReconnectKey`
// is the repair: it notices the disagreement and republishes this
// package's own record.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import { workflowRun } from "@intx/db/schema";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRunKeyHistoryMigrations } from "../src/migrations";
import { createDrizzleRunKeyHistoryStore } from "../src/store";
import { lookupRunKeyHistoryReconnectKey } from "../src/reconnect";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "run_key_history_reconnect_test";
const TENANT = "tnt_run_key_history_reconnect";
const DEFINITION = "wfd_run_key_history_reconnect";

describeIfDb("lookupRunKeyHistoryReconnectKey", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyRunKeyHistoryMigrations(databaseUrl as string);
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  async function withDb<T>(
    run: (db: ReturnType<typeof createDB>["db"]) => Promise<T>,
  ) {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      return await run(db);
    } finally {
      await close();
    }
  }

  async function seedRun(
    runId: string,
    address: string,
    publicKey: string | null,
  ) {
    await withDb(async (db) => {
      await db
        .insert(schema.tenant)
        .values({
          id: TENANT,
          name: "Run Key History Tenant",
          slug: "run-key-history-tenant",
          domain: "run-key-history.workbench.test",
        })
        .onConflictDoNothing();
      await db
        .insert(schema.workflowDefinition)
        .values({
          id: DEFINITION,
          tenantId: TENANT,
          name: "run-key-history-reconnect",
          status: "deployed",
        })
        .onConflictDoNothing();
      await db.insert(workflowRun).values({
        id: runId,
        definitionId: DEFINITION,
        tenantId: TENANT,
        address,
        publicKey,
        status: "deployed",
      });
    });
  }

  test("no observed key at all defers to the caller's own lookup", async () => {
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      const result = await lookupRunKeyHistoryReconnectKey(
        db,
        store,
        "run_never_observed@run-key-history.workbench.test",
      );
      expect(result).toBeNull();
    });
  });

  test("matching keys are a no-op", async () => {
    const address = "run_matching@run-key-history.workbench.test";
    await seedRun("run_matching", address, "key-a");
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");

      const result = await lookupRunKeyHistoryReconnectKey(db, store, address);
      expect(result).toBe("key-a");

      const [row] = await db
        .select({ publicKey: workflowRun.publicKey })
        .from(workflowRun)
        .where(eq(workflowRun.address, address));
      expect(row?.publicKey).toBe("key-a");
    });
  });

  test("crash-loop: a second ack lost mid-outage is repaired on the next reconnect", async () => {
    const address = "run_crash_loop@run-key-history.workbench.test";
    await seedRun("run_crash_loop", address, null);

    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);

      // First deploy: both this package's listener and vendor's own
      // `agent.deploy.ack` handler observe the ack while the hub is up.
      await store.recordObservedKey(address, "key-a");
      await db
        .update(workflowRun)
        .set({ publicKey: "key-a" })
        .where(eq(workflowRun.address, address));

      // The sidecar restarts on a wiped data dir, mints a fresh keypair,
      // and sends a new ack. This package's listener records it, but the
      // hub goes down before vendor's own `UPDATE workflow_run` for the
      // same event commits -- the exact race CL-6281 diagnoses.
      await store.recordObservedKey(address, "key-b");
      // (workflow_run.public_key is deliberately left at "key-a" here.)

      // The sidecar reconnects once the hub is back. Without the repair,
      // the challenge would be built from the stale "key-a" and fail
      // forever against a sidecar that now only holds "key-b"'s private
      // key.
      const result = await lookupRunKeyHistoryReconnectKey(db, store, address);
      expect(result).toBe("key-b");

      const [row] = await db
        .select({ publicKey: workflowRun.publicKey })
        .from(workflowRun)
        .where(eq(workflowRun.address, address));
      expect(row?.publicKey).toBe("key-b");
    });
  });

  test("an address with no workflow_run row is left to the caller's own lookup", async () => {
    const address = "run_unrouted@run-key-history.workbench.test";
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");

      const result = await lookupRunKeyHistoryReconnectKey(db, store, address);
      expect(result).toBeNull();
    });
  });
});
