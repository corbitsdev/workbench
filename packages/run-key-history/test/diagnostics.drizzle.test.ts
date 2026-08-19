// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// reconnect.drizzle.test.ts's setup. Proves the read side of
// `run_key_history` against a real `workflow_run` row: the ordered
// lifecycle for one address, and the four-way classification the
// motivating incident needed — a retired run failing its challenge is
// not the same fault as a live run with a genuinely diverged key or one
// that was never acknowledged at all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRunKeyHistoryMigrations } from "../src/migrations";
import { createDrizzleRunKeyHistoryStore } from "../src/store";
import { runKeyHistory } from "../src/schema";
import {
  countRunIdentityStates,
  getRunIdentityStatus,
  getRunKeyLifecycle,
} from "../src/diagnostics";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "run_key_history_diagnostics_test";
const TENANT = "tnt_run_key_history_diagnostics";
const OTHER_TENANT = "tnt_run_key_history_diagnostics_other";
const DEFINITION = "wfd_run_key_history_diagnostics";
const SIDECAR = "sc_run_key_history_diagnostics";

describeIfDb("run-key-history diagnostics", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyRunKeyHistoryMigrations(databaseUrl as string);
  });

  afterAll(async () => {
    // `applyRunKeyHistoryMigrations` always lands `run_key_history` in
    // its own fixed, global `run_key_history` schema -- unlike the
    // platform tables above, it is never scoped by `SCHEMA` -- so
    // dropping `SCHEMA` alone would leave this suite's rows behind for
    // the next run against the same shared e2e database to collide
    // with.
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.delete(runKeyHistory).where(
        inArray(runKeyHistory.runAddress, [
          "run_lifecycle@run-key-history.workbench.test",
          "run_in_sync@run-key-history.workbench.test",
          "run_diverged@run-key-history.workbench.test",
          "run_unacked@run-key-history.workbench.test",
          "run_failed@run-key-history.workbench.test",
          "run_cancelled@run-key-history.workbench.test",
          "run_count_in_sync@run-key-history.workbench.test",
          "run_sidecar_scoped@run-key-history.workbench.test",
        ]),
      );
    } finally {
      await close();
    }
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

  async function seedTenant(tenantId: string) {
    await withDb(async (db) => {
      await db
        .insert(schema.tenant)
        .values({
          id: tenantId,
          name: "Run Key History Diagnostics Tenant",
          slug: `run-key-history-diagnostics-${tenantId}`,
          domain: `${tenantId}.run-key-history.workbench.test`,
        })
        .onConflictDoNothing();
    });
  }

  async function seedSidecar(sidecarId: string) {
    await withDb(async (db) => {
      await db
        .insert(schema.sidecar)
        .values({
          id: sidecarId,
          tokenHashSha256: new Uint8Array(32).fill(1),
        })
        .onConflictDoNothing();
    });
  }

  async function seedRun(options: {
    runId: string;
    address: string;
    publicKey: string | null;
    status: "deployed" | "running" | "completed" | "failed" | "cancelled";
    tenantId?: string;
    sidecarId?: string;
  }) {
    const tenantId = options.tenantId ?? TENANT;
    await withDb(async (db) => {
      await db
        .insert(schema.workflowDefinition)
        .values({
          id: DEFINITION,
          tenantId,
          name: "run-key-history-diagnostics",
          status: "deployed",
        })
        .onConflictDoNothing();
      await db.insert(schema.workflowRun).values({
        id: options.runId,
        definitionId: DEFINITION,
        tenantId,
        address: options.address,
        publicKey: options.publicKey,
        status: options.status,
        sidecarId: options.sidecarId,
      });
    });
  }

  beforeAll(async () => {
    await seedTenant(TENANT);
    await seedTenant(OTHER_TENANT);
    await seedSidecar(SIDECAR);
  });

  test("getRunKeyLifecycle returns the full ordered history, oldest first", async () => {
    const address = "run_lifecycle@run-key-history.workbench.test";
    await seedRun({
      runId: "run_lifecycle",
      address,
      publicKey: "key-b",
      status: "running",
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");
      await store.recordObservedKey(address, "key-b");

      const lifecycle = await getRunKeyLifecycle(db, address);
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0]?.publicKey).toBe("key-a");
      expect(lifecycle[0]?.supersededAt).not.toBeNull();
      expect(lifecycle[1]?.publicKey).toBe("key-b");
      expect(lifecycle[1]?.supersededAt).toBeNull();
    });
  });

  test("a live run with a matching recorded key is in_sync", async () => {
    const address = "run_in_sync@run-key-history.workbench.test";
    await seedRun({
      runId: "run_in_sync",
      address,
      publicKey: "key-a",
      status: "running",
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");

      const status = await getRunIdentityStatus(db, address);
      expect(status?.state).toBe("in_sync");
      expect(status?.isLive).toBe(true);
    });
  });

  test("a live run whose recorded key disagrees with workflow_run is diverged, not repaired", async () => {
    const address = "run_diverged@run-key-history.workbench.test";
    await seedRun({
      runId: "run_diverged",
      address,
      publicKey: "key-a",
      status: "deployed",
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-b");

      const status = await getRunIdentityStatus(db, address);
      expect(status?.state).toBe("diverged");
      expect(status?.recordedKey).toBe("key-b");
      expect(status?.platformKey).toBe("key-a");

      // Diagnostic only: workflow_run.public_key is left untouched.
      const [row] = await db
        .select({ publicKey: schema.workflowRun.publicKey })
        .from(schema.workflowRun)
        .where(eq(schema.workflowRun.address, address));
      expect(row?.publicKey).toBe("key-a");
    });
  });

  test("a live run never observed by the listener is unacknowledged, not diverged", async () => {
    const address = "run_unacked@run-key-history.workbench.test";
    await seedRun({
      runId: "run_unacked",
      address,
      publicKey: null,
      status: "deployed",
    });
    await withDb(async (db) => {
      const status = await getRunIdentityStatus(db, address);
      expect(status?.state).toBe("unacknowledged");
      expect(status?.recordedKey).toBeNull();
    });
  });

  test("a retired run failing its challenge is retired, never diverged or unacknowledged", async () => {
    const failedAddress = "run_failed@run-key-history.workbench.test";
    await seedRun({
      runId: "run_failed",
      address: failedAddress,
      publicKey: "key-a",
      status: "failed",
    });
    const cancelledAddress = "run_cancelled@run-key-history.workbench.test";
    await seedRun({
      runId: "run_cancelled",
      address: cancelledAddress,
      publicKey: null,
      status: "cancelled",
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      // Even a genuinely diverged key on a retired run must not surface
      // as "diverged" -- its challenge failure is correct behavior.
      await store.recordObservedKey(failedAddress, "key-b");

      const failedStatus = await getRunIdentityStatus(db, failedAddress);
      expect(failedStatus?.state).toBe("retired");
      expect(failedStatus?.isLive).toBe(false);

      const cancelledStatus = await getRunIdentityStatus(db, cancelledAddress);
      expect(cancelledStatus?.state).toBe("retired");
    });
  });

  test("an address with no workflow_run row returns null", async () => {
    await withDb(async (db) => {
      const status = await getRunIdentityStatus(
        db,
        "run_never_deployed@run-key-history.workbench.test",
      );
      expect(status).toBeNull();
    });
  });

  test("countRunIdentityStates tallies a tenant's runs by state and stays scoped to it", async () => {
    await seedRun({
      runId: "run_count_in_sync",
      address: "run_count_in_sync@run-key-history.workbench.test",
      publicKey: "key-a",
      status: "running",
      tenantId: OTHER_TENANT,
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(
        "run_count_in_sync@run-key-history.workbench.test",
        "key-a",
      );

      const otherTenantCounts = await countRunIdentityStates(db, {
        tenantId: OTHER_TENANT,
      });
      expect(otherTenantCounts.inSync).toBe(1);
      expect(otherTenantCounts.retired).toBe(0);
      expect(otherTenantCounts.diverged).toBe(0);
      expect(otherTenantCounts.unacknowledged).toBe(0);

      // The main TENANT fixture accumulated one of each state across the
      // earlier tests in this file: run_in_sync, run_diverged,
      // run_unacked, run_failed, run_cancelled.
      const tenantCounts = await countRunIdentityStates(db, {
        tenantId: TENANT,
      });
      expect(tenantCounts.inSync).toBeGreaterThanOrEqual(1);
      expect(tenantCounts.diverged).toBeGreaterThanOrEqual(1);
      expect(tenantCounts.unacknowledged).toBeGreaterThanOrEqual(1);
      expect(tenantCounts.retired).toBeGreaterThanOrEqual(2);
    });
  });

  test("countRunIdentityStates narrows to one sidecar within the tenant", async () => {
    const address = "run_sidecar_scoped@run-key-history.workbench.test";
    await seedRun({
      runId: "run_sidecar_scoped",
      address,
      publicKey: "key-a",
      status: "running",
      sidecarId: SIDECAR,
    });
    await withDb(async (db) => {
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");

      const scoped = await countRunIdentityStates(db, {
        tenantId: TENANT,
        sidecarId: SIDECAR,
      });
      expect(scoped.inSync).toBe(1);
      expect(
        scoped.retired +
          scoped.diverged +
          scoped.unacknowledged +
          scoped.inSync,
      ).toBe(1);
    });
  });
});
