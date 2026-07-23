import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import { createRepoStore } from "@workbench/hub-sessions";
import type {
  AuthorizeFn,
  KindHandler,
  Principal,
  RepoId,
  ValidatePushResult,
} from "@workbench/hub-sessions";
import type { RunState } from "@intx/workflow";
import { emptyState } from "@intx/workflow";

import { createWorkflowHostSignalChannel } from "./signal-channel";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

let signingKey: KeyPair;

beforeAll(async () => {
  signingKey = await generateKeyPair();
});

afterAll(async () => {
  for (const d of tempDirs.splice(0)) {
    await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {
      /* best effort */
    });
  }
});

function permissiveHandler(directoryPrefix: string): KindHandler {
  return {
    // The signal-channel test uses an `agent-state`-shaped repo for
    // the same reason the scheduler test does: the workflow-run kind
    // handler is not yet registered. The signal channel does not care
    // about the kind discriminator -- only that the substrate accepts
    // writes under `runs/<runId>/events/`.
    kind: "agent-state",
    directoryPrefix,
    validatePush(): ValidatePushResult {
      return { ok: true };
    },
    onRefUpdated() {
      /* no-op */
    },
  };
}

const allowAll: AuthorizeFn = () => ({ allowed: true });
const principal: Principal = { kind: "test" };
const REF = "refs/heads/main";

type StateBox = { state: RunState };

function makeStateBox(runId: string): StateBox {
  return { state: emptyState(runId) };
}

let idCounter = 0;
function makeIdGen(prefix: string): () => string {
  return () => {
    idCounter += 1;
    return `${prefix}-${String(idCounter)}`;
  };
}

// WORKBENCH-LOCAL (CL-3641): seeds a seq-1 RunStarted blob so `deliver()` has a
// non-empty log to append to -- the fork refuses a deliver against an empty log
// (a seq-0 SignalReceived would be rejected by the state machine's seq >= 1
// rule and poison the run), so every deliver test must start the run first.
async function seedRunStarted(
  store: ReturnType<typeof createRepoStore>,
  repoId: RepoId,
  runId: string,
): Promise<void> {
  const prefix = `runs/${runId}/events/`;
  await store.writeTreePreservingPrefix(principal, repoId, REF, {
    preservePrefix: prefix,
    merge: async (existing) => {
      const out: Record<string, string> = {};
      for (const [filepath, contents] of existing) {
        out[filepath] = new TextDecoder().decode(contents);
      }
      out[`${prefix}1.json`] = JSON.stringify({
        type: "RunStarted",
        seq: 1,
        at: new Date().toISOString(),
      });
      return out;
    },
    message: `RunStarted seed for run ${runId}`,
  });
}

describe("workflow-host signal channel", () => {
  test(
    "a live SignalReceived commit resolves a waiting awaitNext",
    async () => {
      const dataDir = await makeTempDir("sigchan-live-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-live") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-live" };
      const runId = "r-live";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const received = channel.awaitNext("approve");
        // Give the subscription a moment to install before the commit
        // lands so the `from: "head"` watcher sees the post-subscribe
        // ref-update.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        await channel.deliver("approve", { ok: true }, "sig-A");
        const out = await received;
        expect(out.signalId).toBe("sig-A");
        expect(out.payload).toEqual({ ok: true });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );

  test(
    "awaitNext returns immediately from unconsumedSignals (resume rehydration)",
    async () => {
      const dataDir = await makeTempDir("sigchan-resume-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-resume") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-resume" };
      const runId = "r-resume";
      const box = makeStateBox(runId);
      // Seed unconsumedSignals as if a log replay observed a
      // SignalReceived before any awaiter subscribed.
      box.state = {
        ...box.state,
        unconsumedSignals: new Map([
          ["approve", [{ id: "sig-queued", payload: { resumed: true } }]],
        ]),
        observedSignalIds: new Set(["sig-queued"]),
      };

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const out = await channel.awaitNext("approve");
        expect(out.signalId).toBe("sig-queued");
        expect(out.payload).toEqual({ resumed: true });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );

  test(
    "AbortSignal cleanly cancels a pending awaiter and tears down its subscription",
    async () => {
      const dataDir = await makeTempDir("sigchan-abort-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-abort") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-abort" };
      const runId = "r-abort";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const ac = new AbortController();
        const pending = channel.awaitNext("approve", ac.signal);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        ac.abort();
        await expect(pending).rejects.toThrow("aborted");

        // After the abort, a deliver for that name must not crash the
        // channel and a fresh awaiter must still resolve normally.
        const second = channel.awaitNext("approve");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        await channel.deliver("approve", { v: 1 }, "sig-second");
        const out = await second;
        expect(out.signalId).toBe("sig-second");
        expect(out.payload).toEqual({ v: 1 });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );

  test(
    "concurrent awaiters on different names resolve independently from their own commits",
    async () => {
      const dataDir = await makeTempDir("sigchan-isolated-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: {
          "agent-state": permissiveHandler("workflow-runs-isolated"),
        },
        authorize: allowAll,
      });
      const repoId: RepoId = {
        kind: "agent-state",
        id: "deployment-isolated",
      };
      const runId = "r-isolated";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const a = channel.awaitNext("approve");
        const b = channel.awaitNext("reject");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        // Deliver in reverse order to make sure the routing is by
        // name and not by arrival order.
        await channel.deliver("reject", { reason: "nope" }, "sig-R");
        await channel.deliver("approve", { ok: true }, "sig-A");
        const [resA, resB] = await Promise.all([a, b]);
        expect(resA.signalId).toBe("sig-A");
        expect(resA.payload).toEqual({ ok: true });
        expect(resB.signalId).toBe("sig-R");
        expect(resB.payload).toEqual({ reason: "nope" });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );

  test(
    "a second awaitNext on the same name after a successful resolve still receives a fresh live commit",
    async () => {
      const dataDir = await makeTempDir("sigchan-relive-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-relive") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-relive" };
      const runId = "r-relive";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const first = channel.awaitNext("approve");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        await channel.deliver("approve", { v: 1 }, "sig-1");
        const r1 = await first;
        expect(r1.signalId).toBe("sig-1");

        // The state machine reduces SignalReceived into
        // observedSignalIds; mark the first id observed so the
        // second-round subscription does not redeliver it from log
        // replay.
        box.state = {
          ...box.state,
          observedSignalIds: new Set(["sig-1"]),
        };

        // A second awaitNext on the same name must install a fresh
        // live subscription. If startNameSubscription's natural-break
        // path leaks the per-name entry in the subscriptions Map,
        // this awaitNext joins the awaiter queue against a dead
        // subscribeKind loop and the deliver below never wakes it.
        const second = channel.awaitNext("approve");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        await channel.deliver("approve", { v: 2 }, "sig-2");
        const r2 = await Promise.race([
          second,
          new Promise<{ payload: unknown; signalId: string }>(
            (_resolve, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error("timeout: second awaitNext did not resolve"),
                  ),
                2000,
              );
            },
          ),
        ]);
        expect(r2.signalId).toBe("sig-2");
        expect(r2.payload).toEqual({ v: 2 });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 10000 },
  );

  test(
    "two awaiters on the same signal name resolve in registration order against two live commits",
    async () => {
      const dataDir = await makeTempDir("sigchan-fifo-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-fifo") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-fifo" };
      const runId = "r-fifo";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        const first = channel.awaitNext("approve");
        const second = channel.awaitNext("approve");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        await channel.deliver("approve", { v: 1 }, "sig-A");
        await channel.deliver("approve", { v: 2 }, "sig-B");
        const r1 = await Promise.race([
          first,
          new Promise<{ payload: unknown; signalId: string }>(
            (_resolve, reject) => {
              setTimeout(
                () => reject(new Error("first awaiter did not resolve")),
                2000,
              );
            },
          ),
        ]);
        const r2 = await Promise.race([
          second,
          new Promise<{ payload: unknown; signalId: string }>(
            (_resolve, reject) => {
              setTimeout(
                () => reject(new Error("second awaiter did not resolve")),
                2000,
              );
            },
          ),
        ]);
        expect(r1.signalId).toBe("sig-A");
        expect(r1.payload).toEqual({ v: 1 });
        expect(r2.signalId).toBe("sig-B");
        expect(r2.payload).toEqual({ v: 2 });
      } finally {
        await channel.stop();
      }
    },
    { timeout: 10000 },
  );

  test(
    "deliver is idempotent on signalId: a re-issued signalId does not duplicate the blob",
    async () => {
      const dataDir = await makeTempDir("sigchan-dedup-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-dedup") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-dedup" };
      const runId = "r-dedup";
      const box = makeStateBox(runId);
      await seedRunStarted(store, repoId, runId);

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        await channel.deliver("approve", { v: 1 }, "sig-dup");
        await channel.deliver("approve", { v: 2 }, "sig-dup");
        const eventsDir = path.join(
          store.getRepoDir(repoId),
          "runs",
          runId,
          "events",
        );
        const entries = await fs.promises.readdir(eventsDir);
        const matching = entries.filter((n) => /^\d+\.json$/.test(n));
        // WORKBENCH-LOCAL (CL-3641): the seeded RunStarted at seq 1 plus a single
        // delivered blob -- the re-issued signalId must not add a second one.
        expect(matching).toHaveLength(2);
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );

  // WORKBENCH-LOCAL (CL-3641): a signal delivered before the child commits
  // RunStarted (seq 1) must be refused, not written at seq 0 -- the state
  // machine rejects seq < 1, so a seq-0 SignalReceived would poison the run
  // log permanently. This guards the cold-start race a reconciler's
  // auto-delivered signal can hit.
  test(
    "deliver refuses to write when the run's events log is empty, and writes nothing",
    async () => {
      const dataDir = await makeTempDir("sigchan-cold-");
      const store = createRepoStore({
        dataDir,
        signingKey,
        handlers: { "agent-state": permissiveHandler("workflow-runs-cold") },
        authorize: allowAll,
      });
      const repoId: RepoId = { kind: "agent-state", id: "deployment-cold" };
      const runId = "r-cold";
      const box = makeStateBox(runId);
      // No seedRunStarted -- this run has never committed RunStarted, the
      // exact race a reconciler's auto-delivered "intake" signal can hit
      // against a cold-starting workflow child.

      const channel = createWorkflowHostSignalChannel({
        repoStore: store,
        principal,
        repoId,
        ref: REF,
        runId,
        readState: () => box.state,
        newId: makeIdGen("sig"),
        clock: () => new Date(),
      });
      try {
        await expect(
          channel.deliver("intake", { ok: true }, "sig-cold"),
        ).rejects.toThrow(/run log has no events yet/);

        const eventsDir = path.join(
          store.getRepoDir(repoId),
          "runs",
          runId,
          "events",
        );
        const exists = await fs.promises
          .access(eventsDir)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const entries = await fs.promises.readdir(eventsDir);
          expect(entries.filter((n) => /^\d+\.json$/.test(n))).toHaveLength(0);
        }
      } finally {
        await channel.stop();
      }
    },
    { timeout: 5000 },
  );
});
