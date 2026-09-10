// The background provisioner: the only thing in the system that
// converges a connected bench (CL-6457, doc-driven since CL-7584).
// Connect persists a credential and returns; this reconciles the bench
// against the tenant desired-state document afterwards, and has to hold
// three properties no HTTP request can hold for it — it is idempotent (a
// second pass over an already-seeded bench installs nothing),
// convergent (a half-provisioned bench finishes on a later pass), and
// restart-safe (a fresh process with nothing in memory picks up
// whatever the crashed one left in the pending-seed table).
import { describe, expect, test } from "bun:test";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS } from "@corbits/seeding";
import {
  createBenchProvisioner,
  type BenchProvisionerDeps,
} from "../src/bench-provisioning";
import {
  createInMemoryPendingSeedStore,
  PENDING_SEED_SCAN_LIMIT,
  type PendingSeed,
  type PendingSeedStore,
} from "../src/pending-seed";

type ReconcileArgsLike = Parameters<
  NonNullable<BenchProvisionerDeps["reconcileFn"]>
>[0];

const TEST_KEY = Buffer.alloc(32, 33);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const SEED: PendingSeed = {
  userId: "user_1",
  tenantId: "ten_1",
  principalId: "prn_1",
  tenantDomain: "user-1.bench.local",
  provider: "anthropic",
  apiKey: "sk-ant-connected",
};

const ALL_WORKFLOWS = DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName);

function readyReport(tenantId: string) {
  return {
    tenantId,
    ready: true as const,
    pins: ALL_WORKFLOWS.map((name) => ({
      name,
      kind: "workflow" as const,
      status: "installed" as const,
    })),
  };
}

function blockedReport(tenantId: string) {
  return {
    tenantId,
    ready: false as const,
    pins: [
      { name: "assistant", kind: "workflow" as const, status: "blocked" as const },
    ],
  };
}

function failedReport(tenantId: string) {
  return {
    tenantId,
    ready: false as const,
    pins: [
      { name: "assistant", kind: "workflow" as const, status: "failed" as const },
    ],
  };
}

/** A provisioner wired entirely to fakes: no hub, no sidecar, no git
 * push. `deployedByTenant` is the fake bench state the reconcile seam
 * reads and writes, so idempotence and convergence are observable as
 * call counts rather than asserted by inspection. */
function harness(
  overrides: Partial<BenchProvisionerDeps> & { store?: PendingSeedStore } = {},
) {
  const store = overrides.store ?? createInMemoryPendingSeedStore(testCipher());
  const deployedByTenant = new Map<string, string[]>();
  const calls = {
    reconcile: 0,
    sessionFor: 0,
  };
  const logged: string[] = [];

  const deps: BenchProvisionerDeps = {
    api: (async () => {
      throw new Error("the fakes below stand in for every hub call");
    }) as unknown as BenchProvisionerDeps["api"],
    hubUrl: "https://bench.example.com",
    store,
    pushWorkflow: async () => ({
      outcome: "pushed" as const,
      commitSha: "a".repeat(40),
    }),
    sessionFor: async () => {
      calls.sessionFor += 1;
      return ["better-auth.session_token=minted"];
    },
    log: (line) => logged.push(line),
    reconcileFn: async (args) => {
      calls.reconcile += 1;
      deployedByTenant.set(args.tenant.tenantId, [...ALL_WORKFLOWS]);
      return readyReport(args.tenant.tenantId);
    },
    ...overrides,
  };

  return {
    provisioner: createBenchProvisioner(deps),
    store,
    calls,
    logged,
    deployedByTenant,
  };
}

describe("createBenchProvisioner", () => {
  test("converges a freshly connected bench and clears its pending row", async () => {
    const { provisioner, store, calls, deployedByTenant } = harness();
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.reconcile).toBe(1);
    expect(deployedByTenant.get("ten_1")).toEqual(ALL_WORKFLOWS);
    expect(report).toMatchObject({ converged: 1, truncated: false });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("is idempotent: a second drain over an already-seeded bench installs nothing", async () => {
    const { provisioner, store, calls } = harness();
    await store.put(SEED);

    await provisioner.drainOnce();
    // The row is gone after the first pass, so re-arm it the way a
    // duplicate connect would and prove the reconcile short-circuits.
    await store.put(SEED);
    await provisioner.drainOnce();

    expect(calls.reconcile).toBe(2);
  });

  test("reconciling a bench someone else already converged reports ready and still clears the row", async () => {
    const { provisioner, store } = harness();
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(report).toMatchObject({ converged: 1, truncated: false });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("a blocked bench keeps its row and converges on a later pass", async () => {
    let attempt = 0;
    const { provisioner, store } = harness({
      reconcileFn: async (args) => {
        attempt += 1;
        if (attempt > 1) {
          return readyReport(args.tenant.tenantId);
        }
        return blockedReport(args.tenant.tenantId);
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ pending: 1 });
    // The row survives precisely so the next pass can finish the job.
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );

    const second = await provisioner.drainOnce({ ignoreBackoff: true });
    expect(second).toMatchObject({ converged: 1 });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("a reconcile failure leaves the row for the next pass rather than losing the bench", async () => {
    let attempt = 0;
    const { provisioner, store, logged } = harness({
      reconcileFn: async (args) => {
        attempt += 1;
        if (attempt === 1) throw new Error("sidecar exploded");
        return readyReport(args.tenant.tenantId);
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ failed: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
    expect(logged.some((line) => line.includes("sidecar exploded"))).toBe(true);

    const second = await provisioner.drainOnce({ ignoreBackoff: true });
    expect(second).toMatchObject({ converged: 1 });
  });

  test("a failed-pin report counts as failed for backoff purposes", async () => {
    const { provisioner, store } = harness({
      reconcileFn: async (args) => failedReport(args.tenant.tenantId),
    });
    await store.put(SEED);

    await provisioner.drainOnce();
    const held = await provisioner.drainOnce();

    expect(held).toMatchObject({ deferred: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
  });

  test("restart-resume: a fresh provisioner with empty memory finishes what a crashed one left behind", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    // The "crashed" process: it wrote the row, then died before its
    // deploy ever ran.
    await store.put(SEED);

    // A brand-new provisioner — no in-flight map, no backoff state, no
    // knowledge of the connect that wrote the row — boots and drains.
    const { provisioner, calls, deployedByTenant } = harness({ store });
    const report = await provisioner.drainOnce();

    expect(calls.reconcile).toBe(1);
    expect(deployedByTenant.get("ten_1")).toEqual(ALL_WORKFLOWS);
    expect(report).toMatchObject({ converged: 1, truncated: false });
  });

  test("overlapping drains never double-provision the same bench", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let reconciles = 0;
    const { provisioner, store } = harness({
      reconcileFn: async (args) => {
        reconciles += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return readyReport(args.tenant.tenantId);
      },
    });
    await store.put(SEED);

    await Promise.all([provisioner.drainOnce(), provisioner.drainOnce()]);

    expect(maxConcurrent).toBe(1);
    expect(reconciles).toBe(1);
  });

  test("a blocked report holds the pending row as pending, not failed", async () => {
    const { provisioner, store } = harness({
      reconcileFn: async (args) => blockedReport(args.tenant.tenantId),
    });
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(report).toMatchObject({ pending: 1, failed: 0 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
  });

  test("a bench whose user has no mintable session is left alone, not dropped", async () => {
    const { provisioner, store, calls } = harness({
      sessionFor: async () => undefined,
    });
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.reconcile).toBe(0);
    expect(report).toMatchObject({ failed: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
  });

  test("a permanently-failing bench's backoff is reclaimed once its row is gone, not only on success", async () => {
    // Simulates the CL-7233 orphan case: the pending_seed row disappears
    // (TTL-expiry or otherwise) while the bench is still backed off from
    // repeated failures — the retry-hold bookkeeping must not survive
    // the row that justified it.
    const { provisioner, store } = harness({
      reconcileFn: async () => {
        throw new Error("sidecar still down");
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ failed: 1 });
    // Confirm the hold is actually in effect before the row disappears —
    // otherwise this test would pass for the wrong reason.
    const stillBackedOff = await provisioner.drainOnce();
    expect(stillBackedOff).toMatchObject({ deferred: 1 });

    // The row is gone by some path other than this provisioner's own
    // convergence (an admin action, or read-time TTL expiry elsewhere).
    await store.clear({ userId: "user_1", tenantId: "ten_1" });
    const afterRowGone = await provisioner.drainOnce();
    expect(afterRowGone).toMatchObject({
      converged: 0,
      pending: 0,
      failed: 0,
      deferred: 0,
    });

    // A brand-new connect for the same user/tenant must not inherit the
    // dead bench's backoff — without eviction, this would come back
    // deferred instead of attempted.
    await store.put(SEED);
    const freshAttempt = await provisioner.drainOnce();
    expect(freshAttempt).toMatchObject({ failed: 1 });
  });

  test("drains every waiting bench in one tick, not just the first", async () => {
    const { provisioner, store, calls } = harness();
    await store.put(SEED);
    await store.put({ ...SEED, userId: "user_2", tenantId: "ten_2" });

    const report = await provisioner.drainOnce();

    expect(calls.reconcile).toBe(2);
    expect(report).toMatchObject({ converged: 2, truncated: false });
  });

  test("DrainReport.truncated is true when more due rows remain behind this tick's page", async () => {
    const seen = new Set<string>();
    const { provisioner, store } = harness({
      reconcileFn: async (args: ReconcileArgsLike) => {
        seen.add(args.tenant.tenantId);
        return blockedReport(args.tenant.tenantId);
      },
    });
    for (let index = 0; index < PENDING_SEED_SCAN_LIMIT + 3; index += 1) {
      await store.put({
        ...SEED,
        userId: `user_${index}`,
        tenantId: `ten_${index}`,
      });
    }

    const first = await provisioner.drainOnce();
    expect(first.truncated).toBe(true);
    expect(first.pending).toBe(PENDING_SEED_SCAN_LIMIT);
    expect(seen.size).toBe(PENDING_SEED_SCAN_LIMIT);

    const second = await provisioner.drainOnce();
    expect(second.truncated).toBe(false);
    expect(second.pending).toBe(3);
    expect(seen.size).toBe(PENDING_SEED_SCAN_LIMIT + 3);
  });

  test("rows past the scan limit still get a drain pass across ticks, even when the first page never converges", async () => {
    const seen = new Set<string>();
    const { provisioner, store } = harness({
      reconcileFn: async (args: ReconcileArgsLike) => {
        seen.add(args.tenant.tenantId);
        return blockedReport(args.tenant.tenantId);
      },
    });
    const total = PENDING_SEED_SCAN_LIMIT + 3;
    for (let index = 0; index < total; index += 1) {
      await store.put({
        ...SEED,
        userId: `user_${index}`,
        tenantId: `ten_${index}`,
      });
    }

    await provisioner.drainOnce();
    await provisioner.drainOnce();

    expect(seen.size).toBe(total);
    for (let index = 0; index < total; index += 1) {
      expect(seen.has(`ten_${index}`)).toBe(true);
    }
  });
});
