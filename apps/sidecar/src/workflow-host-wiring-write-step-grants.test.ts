// CL-2783: `writeStepGrants` writes each step's grants into its own
// `<deploymentId>-<stepId>` agent-state repo, bounded-concurrently. The
// writes are on the workflow-spawn critical path; parallelizing the
// per-step isogit commit+fsync waits cuts ~254ms/step off cold start.
//
// These pin the two properties the serial loop guaranteed and the
// bounded-parallel version must preserve:
//   (a) every step's `grants.json` lands in its own repo, and
//   (b) if any single step's write rejects, the whole call rejects
//       (fail-at-deploy: the caller's `finally` unwinds partial state).
// Plus the properties the parallelization adds:
//   (c) writes actually overlap (the pool does not serialize them),
//   (d) concurrency is bounded (a large workflow does not open an
//       unbounded number of writes/fds at once), and
//   (e) on failure the pool DRAINS: no sibling write is still mid-commit when
//       the rejection reaches the caller (else a retried deploy at the same
//       address could race a straggler's commit into a step repo).

import { describe, test, expect } from "bun:test";
import type { RepoId } from "@workbench/hub-sessions";

import {
  writeStepGrants,
  STEP_GRANTS_PATH_FOR_TEST,
} from "./workflow-host-wiring";

type WriteCall = { repoId: RepoId; files: Record<string, string> };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("writeStepGrants", () => {
  const deriveStepRepoId = ({
    deploymentId,
    stepId,
  }: {
    deploymentId: string;
    stepId: string;
  }): RepoId => ({ kind: "agent-state", id: `${deploymentId}-${stepId}` });

  test("writes each step's grants to its own <deploymentId>-<stepId> repo", async () => {
    const calls: WriteCall[] = [];
    const repoStore = {
      writeTree(
        _p: unknown,
        repoId: RepoId,
        _ref: unknown,
        content: { files: Record<string, string> },
      ) {
        calls.push({ repoId, files: content.files });
        return Promise.resolve({ commitSha: "sha", newlyTerminalRuns: [] });
      },
    } as unknown as Parameters<typeof writeStepGrants>[0]["repoStore"];

    const grants = [{ tool: "x", effect: "allow" }];
    await writeStepGrants({
      repoStore,
      deploymentId: "dep1",
      stepOrder: ["s1", "s2", "s3"],
      deriveStepRepoId,
      grants,
    });

    expect(calls.map((c) => c.repoId.id).sort()).toEqual([
      "dep1-s1",
      "dep1-s2",
      "dep1-s3",
    ]);
    for (const c of calls) {
      const raw = c.files[STEP_GRANTS_PATH_FOR_TEST];
      if (raw === undefined) throw new Error("grants file missing");
      expect(JSON.parse(raw)).toEqual({ grants });
    }
  });

  test("absent grants serialize to a fail-closed empty array", async () => {
    const calls: WriteCall[] = [];
    const repoStore = {
      writeTree(
        _p: unknown,
        repoId: RepoId,
        _ref: unknown,
        content: { files: Record<string, string> },
      ) {
        calls.push({ repoId, files: content.files });
        return Promise.resolve({ commitSha: "sha", newlyTerminalRuns: [] });
      },
    } as unknown as Parameters<typeof writeStepGrants>[0]["repoStore"];

    await writeStepGrants({
      repoStore,
      deploymentId: "dep1",
      stepOrder: ["s1"],
      deriveStepRepoId,
      grants: undefined,
    });

    const raw = calls[0]?.files[STEP_GRANTS_PATH_FOR_TEST];
    if (raw === undefined) throw new Error("grants file missing");
    expect(JSON.parse(raw)).toEqual({ grants: [] });
  });

  test("rejects if any single step's write rejects (fail-at-deploy)", async () => {
    const repoStore = {
      writeTree(_p: unknown, repoId: RepoId) {
        if (repoId.id === "dep1-s2") {
          return Promise.reject(new Error("disk full for s2"));
        }
        return Promise.resolve({ commitSha: "sha", newlyTerminalRuns: [] });
      },
    } as unknown as Parameters<typeof writeStepGrants>[0]["repoStore"];

    await expect(
      writeStepGrants({
        repoStore,
        deploymentId: "dep1",
        stepOrder: ["s1", "s2", "s3"],
        deriveStepRepoId,
        grants: [],
      }),
    ).rejects.toThrow("disk full for s2");
  });

  test("drains in-flight sibling writes before the failure reaches the caller (no straggler mid-commit at teardown)", async () => {
    // A bare Promise.all rejects the instant one worker throws, while sibling
    // workers are still mid-commit into their step repos — the caller's
    // teardown (releaseSlug -> a retried deploy at the same address) could then
    // race a straggler's commit. The pool must instead drain: no writer may
    // still be committing when the rejection reaches the caller.
    const gate = deferred();
    let active = 0;
    let boomThrew: () => void = () => undefined;
    const boomHappened = new Promise<void>((r) => {
      boomThrew = r;
    });

    const repoStore = {
      async writeTree(_p: unknown, repoId: RepoId) {
        active += 1;
        try {
          if (repoId.id === "dep1-boom") {
            boomThrew();
            throw new Error("boom on the failing step");
          }
          // Sibling writers stay in flight until the gate opens.
          await gate.promise;
          return { commitSha: "sha", newlyTerminalRuns: [] };
        } finally {
          active -= 1;
        }
      },
    } as unknown as Parameters<typeof writeStepGrants>[0]["repoStore"];

    // "boom" sits after two slow siblings so both are in flight when it throws.
    const done = writeStepGrants({
      repoStore,
      deploymentId: "dep1",
      stepOrder: ["slow1", "slow2", "boom", "slow3"],
      deriveStepRepoId,
      grants: [],
    });
    let settled = "pending";
    void done.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );

    await boomHappened;
    // The failure is recorded, but the call MUST NOT settle while sibling
    // writes are still committing. (The `failed` flag is observed on a later
    // microtask, so more than one sibling can already be in flight — the exact
    // count is scheduling-dependent; the load-bearing fact is that >1 sibling
    // is mid-commit and the call has not settled.)
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe("pending");
    expect(active).toBeGreaterThanOrEqual(2);

    // Release the siblings; only now may the call reject — and by then every
    // in-flight write has drained (no straggler still committing).
    gate.resolve();
    await expect(done).rejects.toThrow("boom on the failing step");
    expect(active).toBe(0);
  });

  test("overlaps writes concurrently (does not serialize) yet bounds the pool", async () => {
    const STEPS = 30;
    const POOL_MAX = 12;
    let inFlight = 0;
    let peak = 0;
    const gate = deferred();
    let firstBatchArrived: () => void = () => undefined;
    const firstBatch = new Promise<void>((r) => {
      firstBatchArrived = r;
    });

    const repoStore = {
      async writeTree() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Once the pool is saturated, release the gate so the started
        // writes can complete. A serial loop would only ever reach
        // inFlight === 1 and deadlock here (gate never opens), so the
        // test's completion itself proves overlap.
        if (inFlight >= POOL_MAX) firstBatchArrived();
        await gate.promise;
        inFlight -= 1;
        return { commitSha: "sha", newlyTerminalRuns: [] };
      },
    } as unknown as Parameters<typeof writeStepGrants>[0]["repoStore"];

    const done = writeStepGrants({
      repoStore,
      deploymentId: "dep1",
      stepOrder: Array.from({ length: STEPS }, (_, i) => `s${i}`),
      deriveStepRepoId,
      grants: [],
    });

    await firstBatch;
    // Concurrency is bounded: never more than POOL_MAX writes at once.
    expect(peak).toBeLessThanOrEqual(POOL_MAX);
    // And it did overlap — a serial loop would peak at 1.
    expect(peak).toBeGreaterThan(1);
    gate.resolve();
    await done;
  });
});
