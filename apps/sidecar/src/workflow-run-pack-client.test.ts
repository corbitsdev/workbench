import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";

import type { RepoId, RepoStore } from "@intx/hub-sessions";
import { receivePackObjects } from "@workbench/storage-isogit";
import { WorkflowRunPackQuarantinedError } from "@workbench/hub-agent";

import {
  createDeploymentAddressRegistry,
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createWorkflowRunPackClient,
  createWorkflowRunPackPushingRepoStore,
  WorkflowRunPackTooLargeError,
} from "./workflow-run-pack-client";

// Build a real linear workflow-run repo and append one commit per call, the
// append-one-commit-per-event shape the pack client walks.
async function makeWorkflowRunRepo(): Promise<{
  dir: string;
  commit: (seq: number) => Promise<string>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wf-pack-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "runs", "r-1", "events"), { recursive: true });
  async function commit(seq: number): Promise<string> {
    await writeFile(
      join(dir, "runs", "r-1", "events", `${String(seq)}.json`),
      JSON.stringify({ seq }),
    );
    await git.add({ fs, dir, filepath: `runs/r-1/events/${String(seq)}.json` });
    return git.commit({
      fs,
      dir,
      message: `event-${String(seq)}`,
      author: { name: "test", email: "test@example.com" },
    });
  }
  return { dir, commit };
}

function createRecordingUnderlyingRepoStore(repoDir = "/tmp/unused"): {
  store: RepoStore;
  preserveCalls: {
    principal: { kind: string };
    repoId: RepoId;
    ref: string;
  }[];
  packs: { principal: { kind: string }; repoId: RepoId; ref: string }[];
} {
  const preserveCalls: {
    principal: { kind: string };
    repoId: RepoId;
    ref: string;
  }[] = [];
  const packs: {
    principal: { kind: string };
    repoId: RepoId;
    ref: string;
  }[] = [];
  const stub: Partial<RepoStore> = {
    getRepoDir(_repoId: RepoId): string {
      return repoDir;
    },
    async writeTreePreservingPrefix(principal, repoId, ref, args) {
      preserveCalls.push({ principal, repoId, ref });
      await args.merge(new Map());
      return {
        commitSha: `sha-${String(preserveCalls.length)}`,
        newlyTerminalRuns: [],
      };
    },
    async createPack(principal, repoId, ref) {
      packs.push({ principal, repoId, ref });
      return {
        pack: new Uint8Array([0xab, 0xcd]),
        commitSha: "stub-pack-sha",
        ref,
      };
    },
  };

  const store = new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(
          `stub RepoStore: ${String(prop)} not implemented for this test`,
        );
      };
    },
  });
  return { store, preserveCalls, packs };
}

describe("createWorkflowRunPackClient", () => {
  test("push ships the FULL commit chain so a fresh hub can receive it without a dangling parent", async () => {
    // Workflow-run repos are linear, append-one-commit-per-event histories.
    // The client must pack the WHOLE chain (root → tip), not just the tip
    // commit's tree — otherwise the hub's receiver throws
    // `pack_walk_dangling_parent` on the missing ancestor and the run's
    // events never sync (the "Loading…" forever bug — CL-2230). This drives a
    // multi-commit source repo, builds the pack via the real client, and
    // feeds it to the hub's actual receiver (`receivePackObjects`) against an
    // EMPTY target repo (the first-push-to-empty-hub case). A single-commit
    // pack fails here; the full-chain pack succeeds.
    const sourceDir = await mkdtemp(join(tmpdir(), "wf-pack-src-"));
    const targetDir = await mkdtemp(join(tmpdir(), "wf-pack-dst-"));
    try {
      await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
      await mkdir(join(sourceDir, "runs", "r-1", "events"), {
        recursive: true,
      });
      let tipSha = "";
      for (let i = 0; i < 3; i += 1) {
        await writeFile(
          join(sourceDir, "runs", "r-1", "events", `${String(i)}.json`),
          JSON.stringify({ seq: i }),
        );
        await git.add({
          fs,
          dir: sourceDir,
          filepath: `runs/r-1/events/${String(i)}.json`,
        });
        tipSha = await git.commit({
          fs,
          dir: sourceDir,
          message: `event-${String(i)}`,
          author: { name: "test", email: "test@example.com" },
        });
      }

      const { store } = createRecordingUnderlyingRepoStore(sourceDir);
      const sent: {
        pack: Uint8Array;
        ref: string;
        commitSha: string;
      }[] = [];
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            sent.push({
              pack: opts.pack,
              ref: opts.ref,
              commitSha: opts.commitSha,
            });
          },
        },
      });

      await client.push({
        agentAddress: "agent@example.com",
        repoId: { kind: "workflow-run", id: "agent-example-com" },
        ref: "refs/heads/main",
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]?.commitSha).toBe(tipSha);

      // The hub's real receiver applies the pack into an empty repo. This is
      // the exact path that throws `pack_walk_dangling_parent` if any ancestor
      // commit is missing from the pack.
      await git.init({ fs, dir: targetDir, defaultBranch: "main" });
      // Returns the PREVIOUS sha (null for an empty target); the key is that
      // it does NOT throw `pack_walk_dangling_parent` and writes the ref to
      // the tip. A single-commit pack would throw here.
      const prevSha = await receivePackObjects(
        targetDir,
        sent[0]!.pack,
        "refs/heads/main",
        tipSha,
        "test-transfer-1",
        null,
      );
      expect(prevSha).toBeNull();
      // The target now resolves the tip and can walk the whole chain (3
      // commits) without a NotFound — i.e. no dangling parent.
      expect(
        await git.resolveRef({ fs, dir: targetDir, ref: "refs/heads/main" }),
      ).toBe(tipSha);
      const log = await git.log({ fs, dir: targetDir, ref: "refs/heads/main" });
      expect(log.length).toBe(3);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  test("after an acked push, the next push ships only NEW commits as a delta the hub already-warm receiver applies", async () => {
    // The cursor advances on ack, so the second push must carry only the
    // commits appended since the first — proportional to NEW events, not the
    // whole run history (the O(N^2) growth that OOM-killed the sidecar,
    // CL-2340). We prove "delta, not full chain" two ways: the warm hub
    // applies the second pack cleanly onto the tip it already holds, AND that
    // second pack does NOT apply onto an EMPTY repo (it lacks the ancestors).
    const src = await makeWorkflowRunRepo();
    const hubDir = await mkdtemp(join(tmpdir(), "wf-hub-"));
    const emptyDir = await mkdtemp(join(tmpdir(), "wf-empty-"));
    try {
      await git.init({ fs, dir: hubDir, defaultBranch: "main" });
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let hubTip: string | null = null;
      let transfer = 0;
      let lastPack: Uint8Array | null = null;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            // Stand in for the real hub: durably apply the pack, then ack.
            transfer += 1;
            lastPack = opts.pack;
            await receivePackObjects(
              hubDir,
              opts.pack,
              opts.ref,
              opts.commitSha,
              `t-${String(transfer)}`,
              hubTip,
            );
            hubTip = opts.commitSha;
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";

      await src.commit(0);
      await src.commit(1);
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      expect(await git.log({ fs, dir: hubDir, ref })).toHaveLength(2);

      const c2 = await src.commit(2);
      const c3 = await src.commit(3);
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      // Warm hub now holds the full 4-commit chain with no dangling parent.
      expect(await git.resolveRef({ fs, dir: hubDir, ref })).toBe(c3);
      expect(await git.log({ fs, dir: hubDir, ref })).toHaveLength(4);

      // The second pack is a genuine delta: applied to an EMPTY repo its
      // objects lack the ancestors c0/c1, so a full-history walk from the tip
      // cannot complete (throws on the missing parent, or truncates short of
      // the 4 commits a full-chain pack would carry). A full-chain second pack
      // would instead walk all 4 here.
      await git.init({ fs, dir: emptyDir, defaultBranch: "main" });
      expect(lastPack).not.toBeNull();
      await receivePackObjects(emptyDir, lastPack!, ref, c3, "t-empty", null);
      let fullWalk = -1;
      try {
        fullWalk = (await git.log({ fs, dir: emptyDir, ref })).length;
      } catch {
        fullWalk = -1;
      }
      expect(fullWalk).toBeLessThan(4);
      // Sanity: the delta really did carry c2 and c3 onto the warm hub.
      expect(c2).not.toBe(c3);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(hubDir, { recursive: true, force: true });
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("a rejected push does NOT advance the cursor, so the retry re-ships the un-acked commits", async () => {
    // The mirror of the upstream poisoning bug: because the cursor advances
    // only on ack, a failed push leaves it pointing at the last GOOD tip. The
    // next push therefore re-includes the commits the rejected push tried to
    // send, and the warm hub applies them with no dangling parent (CL-2340).
    const src = await makeWorkflowRunRepo();
    const hubDir = await mkdtemp(join(tmpdir(), "wf-hub-"));
    try {
      await git.init({ fs, dir: hubDir, defaultBranch: "main" });
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let hubTip: string | null = null;
      let transfer = 0;
      let rejectNext = false;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            if (rejectNext) {
              throw new Error("hub_rejected: simulated transient");
            }
            transfer += 1;
            await receivePackObjects(
              hubDir,
              opts.pack,
              opts.ref,
              opts.commitSha,
              `t-${String(transfer)}`,
              hubTip,
            );
            hubTip = opts.commitSha;
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";

      await src.commit(0);
      await src.commit(1);
      await client.push({ agentAddress: "a@example.com", repoId, ref }); // cursor -> c1
      expect(await git.log({ fs, dir: hubDir, ref })).toHaveLength(2);

      await src.commit(2);
      rejectNext = true;
      await expect(
        client.push({ agentAddress: "a@example.com", repoId, ref }),
      ).rejects.toThrow(/simulated transient/);
      rejectNext = false;

      const c3 = await src.commit(3);
      // Cursor stayed at c1, so this delta re-ships c2 and c3; the warm hub
      // applies both and lands on c3 with the full 4-commit chain intact.
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      expect(await git.resolveRef({ fs, dir: hubDir, ref })).toBe(c3);
      expect(await git.log({ fs, dir: hubDir, ref })).toHaveLength(4);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(hubDir, { recursive: true, force: true });
    }
  });

  test("a failed push resets the cursor so the next push self-heals with a full chain a cold hub can apply", async () => {
    // Critique #1: the cursor must not strand a run against a hub that lost its
    // base (a cold-restarted hub whose durable repo was wiped). A failed push
    // drops the cursor, so the retry re-bootstraps a full chain — exactly the
    // self-healing the old full-chain pack always had (CL-2340).
    const src = await makeWorkflowRunRepo();
    const coldHub = await mkdtemp(join(tmpdir(), "wf-cold-"));
    try {
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let failNext = false;
      let lastPack: Uint8Array | null = null;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            lastPack = opts.pack;
            if (failNext)
              throw new Error("hub_rejected: pack_walk_dangling_parent");
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";

      await src.commit(0);
      await src.commit(1);
      await client.push({ agentAddress: "a@example.com", repoId, ref }); // cursor -> c1

      // Hub lost its base; this delta push fails and must clear the cursor.
      const c2 = await src.commit(2);
      failNext = true;
      await expect(
        client.push({ agentAddress: "a@example.com", repoId, ref }),
      ).rejects.toThrow(/dangling/);
      failNext = false;

      // Retry: cursor was reset, so this is a FULL chain that applies onto a
      // brand-new cold hub with all 3 commits and no dangling parent.
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      await git.init({ fs, dir: coldHub, defaultBranch: "main" });
      expect(lastPack).not.toBeNull();
      await receivePackObjects(coldHub, lastPack!, ref, c2, "t-cold", null);
      expect(await git.log({ fs, dir: coldHub, ref })).toHaveLength(3);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(coldHub, { recursive: true, force: true });
    }
  });

  test("a quarantined push does NOT reset the cursor, keeping later walks bounded to a delta", async () => {
    // CL-3796: hub-link's CL-3415 quarantine fast-fail (WorkflowRunPackQuarantinedError)
    // means the hub has already rejected this (repoId, ref) repeatedly and
    // will keep doing so without a network attempt. Resetting the cursor on
    // this error buys nothing -- the push is still doomed -- and only forces
    // the NEXT buildDeltaPack to walk an ever-growing history (the event-
    // loop-blocking git walk the retry storm was traced to). Proven the same
    // way as the "delta, not full chain" test above: a pack built after the
    // cursor was supposedly preserved must fail to apply onto an EMPTY repo
    // (it lacks earlier ancestors) -- a full-chain resend would succeed there.
    const src = await makeWorkflowRunRepo();
    const emptyDir = await mkdtemp(join(tmpdir(), "wf-empty-quarantine-"));
    try {
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let mode: "ack" | "quarantined" = "ack";
      let lastPack: Uint8Array | null = null;
      let lastCommitSha = "";
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            lastPack = opts.pack;
            lastCommitSha = opts.commitSha;
            if (mode === "quarantined") {
              throw new WorkflowRunPackQuarantinedError(
                "workflow-run pack push for agent-example-com/refs/heads/main is " +
                  "quarantined after 3 consecutive bootstrap-retry failures " +
                  "(reason=corrupt); dropping without a network attempt",
              );
            }
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";

      // First push acks and advances the cursor to c1.
      await src.commit(0);
      await src.commit(1);
      await client.push({ agentAddress: "a@example.com", repoId, ref });

      // Second push (c2) is quarantined. If the cursor were reset to null
      // here, the THIRD push below would carry the full c0-c2 chain.
      mode = "quarantined";
      await src.commit(2);
      await expect(
        client.push({ agentAddress: "a@example.com", repoId, ref }),
      ).rejects.toBeInstanceOf(WorkflowRunPackQuarantinedError);

      // Third push (c3), still quarantined. Its delta must be bounded to
      // "since c1" (i.e. c2, c3) -- NOT the full chain from root.
      const c3 = await src.commit(3);
      await expect(
        client.push({ agentAddress: "a@example.com", repoId, ref }),
      ).rejects.toBeInstanceOf(WorkflowRunPackQuarantinedError);
      expect(lastCommitSha).toBe(c3);

      await git.init({ fs, dir: emptyDir, defaultBranch: "main" });
      expect(lastPack).not.toBeNull();
      // A bounded delta (c2, c3 only) is missing c1's tree/blob objects as an
      // ancestor and cannot resolve the full log against an empty repo --
      // a reset-to-null full-chain resend would instead succeed here.
      await receivePackObjects(
        emptyDir,
        lastPack!,
        ref,
        c3,
        "t-quarantine",
        null,
      );
      let fullWalkLength = -1;
      try {
        fullWalkLength = (await git.log({ fs, dir: emptyDir, ref })).length;
      } catch {
        fullWalkLength = -1;
      }
      expect(fullWalkLength).toBeLessThan(4);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("a push whose tip is unchanged since the last ack is a no-op", async () => {
    const src = await makeWorkflowRunRepo();
    try {
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      const sent: string[] = [];
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            sent.push(opts.commitSha);
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";
      await src.commit(0);
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      expect(sent).toHaveLength(1);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  test("push throws WorkflowRunPackTooLargeError before building a pack that exceeds the commit ceiling", async () => {
    const src = await makeWorkflowRunRepo();
    try {
      for (let i = 0; i < 4; i += 1) await src.commit(i);
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let pushed = 0;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack() {
            pushed += 1;
          },
        },
        limits: { maxCommits: 2, maxObjects: 1_000_000 },
      });
      await expect(
        client.push({
          agentAddress: "a@example.com",
          repoId: { kind: "workflow-run", id: "agent-example-com" },
          ref: "refs/heads/main",
        }),
      ).rejects.toBeInstanceOf(WorkflowRunPackTooLargeError);
      // The ceiling trips during the walk, before any pack is shipped.
      expect(pushed).toBe(0);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  test("push throws WorkflowRunPackTooLargeError when the object ceiling is exceeded", async () => {
    const src = await makeWorkflowRunRepo();
    try {
      for (let i = 0; i < 3; i += 1) await src.commit(i);
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: { pushWorkflowRunPack: () => Promise.resolve() },
        limits: { maxCommits: 1_000_000, maxObjects: 1 },
      });
      await expect(
        client.push({
          agentAddress: "a@example.com",
          repoId: { kind: "workflow-run", id: "agent-example-com" },
          ref: "refs/heads/main",
        }),
      ).rejects.toBeInstanceOf(WorkflowRunPackTooLargeError);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  test("forgetDeployment resets the cursor so the next push ships the full chain again", async () => {
    // On undeploy the cursor must be dropped: a redeploy may face a fresh hub
    // that no longer holds the prior tip, so the client must re-bootstrap from
    // a full chain rather than a delta whose base is gone (CL-2340).
    const src = await makeWorkflowRunRepo();
    const freshHub = await mkdtemp(join(tmpdir(), "wf-fresh-"));
    try {
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let lastPack: Uint8Array | null = null;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            lastPack = opts.pack;
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";
      await src.commit(0);
      await src.commit(1);
      await client.push({ agentAddress: "a@example.com", repoId, ref }); // cursor -> c1

      client.forgetDeployment("agent-example-com");

      const c2 = await src.commit(2);
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      // Cursor was cleared, so this pack is the FULL chain: it applies onto a
      // brand-new empty hub with all 3 commits and no dangling parent. A
      // delta (cursor still at c1) would have dangled here.
      await git.init({ fs, dir: freshHub, defaultBranch: "main" });
      expect(lastPack).not.toBeNull();
      await receivePackObjects(freshHub, lastPack!, ref, c2, "t-fresh", null);
      expect(await git.log({ fs, dir: freshHub, ref })).toHaveLength(3);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(freshHub, { recursive: true, force: true });
    }
  });

  test("forgetDeployment during an in-flight push is not resurrected when that push later acks", async () => {
    // The undeploy seam: forgetDeployment can land WHILE a push is parked on an
    // unresolved pushWorkflowRunPack. When that push finally acks it must NOT
    // re-set the cursor — otherwise a redeploy ships a delta against a tip the
    // (possibly fresh) hub no longer holds, the exact dangling-delta
    // forgetDeployment exists to prevent (CL-2340). The drain barrier in the
    // undeploy hook normally orders this, but the cursor logic itself must also
    // be safe if an ack races the clear.
    const src = await makeWorkflowRunRepo();
    const freshHub = await mkdtemp(join(tmpdir(), "wf-resurrect-"));
    try {
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      let releasePush: () => void = () => {
        throw new Error("test: push gate resolver not captured before use");
      };
      const pushGate = new Promise<void>((resolve) => {
        releasePush = resolve;
      });
      let gateArmed = true;
      let lastPack: Uint8Array | null = null;
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: {
          async pushWorkflowRunPack(opts) {
            lastPack = opts.pack;
            if (gateArmed) await pushGate;
          },
        },
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      const ref = "refs/heads/main";
      await src.commit(0);
      await src.commit(1);

      // First push parks inside pushWorkflowRunPack (gate unresolved).
      const parked = client.push({
        agentAddress: "a@example.com",
        repoId,
        ref,
      });
      // Undeploy fires while the push is in flight.
      client.forgetDeployment("agent-example-com");
      // Now let the in-flight push ack. If the cursor logic naively set the tip
      // on ack, it would resurrect the cleared cursor here.
      releasePush();
      await parked;

      // Next push must therefore ship the FULL chain (cursor still cleared),
      // applicable onto a brand-new empty hub. A resurrected cursor would have
      // produced a delta that dangles on the fresh hub.
      gateArmed = false;
      const c2 = await src.commit(2);
      await client.push({ agentAddress: "a@example.com", repoId, ref });
      await git.init({ fs, dir: freshHub, defaultBranch: "main" });
      expect(lastPack).not.toBeNull();
      await receivePackObjects(
        freshHub,
        lastPack!,
        ref,
        c2,
        "t-resurrect",
        null,
      );
      expect(await git.log({ fs, dir: freshHub, ref })).toHaveLength(3);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(freshHub, { recursive: true, force: true });
    }
  });

  test("push rejects when given a non-workflow-run repoId", async () => {
    const { store } = createRecordingUnderlyingRepoStore();
    const client = createWorkflowRunPackClient({
      substrate: store,
      hubLink: {
        pushWorkflowRunPack: () => Promise.resolve(),
      },
    });
    await expect(
      client.push({
        agentAddress: "a@example.com",
        repoId: { kind: "agent-state", id: "a@example.com" },
        ref: "refs/heads/deploy",
      }),
    ).rejects.toThrow(/workflow-run/);
  });
});

describe("createWorkflowRunPackPushingRepoStore", () => {
  test("writeTreePreservingPrefix against a workflow-run repo fires the push hook", async () => {
    const { store, preserveCalls } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    registry.record("dep-1", "agent-1@example.com");
    const pushed: { agentAddress: string; repoId: RepoId; ref: string }[] = [];
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        async push(opts) {
          pushed.push(opts);
        },
      },
      registry,
    });

    const repoId: RepoId = { kind: "workflow-run", id: "dep-1" };
    const result = await facade.writeTreePreservingPrefix(
      { kind: "supervisor" },
      repoId,
      "refs/heads/main",
      {
        preservePrefix: "runs/r-1/events/",
        merge: async () => ({ "runs/r-1/events/0.json": "{}" }),
        message: "append RunStarted",
      },
    );
    await facade.flushWorkflowRunPushes(repoId, "refs/heads/main");

    expect(result.commitSha).toBe("sha-1");
    expect(preserveCalls).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.agentAddress).toBe("agent-1@example.com");
    expect(pushed[0]?.repoId.id).toBe("dep-1");
    expect(pushed[0]?.ref).toBe("refs/heads/main");
  });

  test("writeTreePreservingPrefix returns before the pack push finishes", async () => {
    // The facade is required to return from writeTreePreservingPrefix
    // as soon as the local commit lands; the pack push runs
    // asynchronously. This is the throughput-critical behaviour the
    // fifo-mail load test depends on -- without it, every
    // supervisor write pays a full hub-ack round-trip in series and
    // the dispatch loop's per-mail wall-clock balloons to ~15-25s/mail
    // under sustained pressure.
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    registry.record("dep-pipeline", "agent-pipeline@example.com");
    let resolvePush: () => void = () => {
      throw new Error("test: gate resolver was not captured before use");
    };
    const gate = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const pushOrder: string[] = [];
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        async push() {
          pushOrder.push("enter");
          await gate;
          pushOrder.push("exit");
        },
      },
      registry,
    });

    const repoId: RepoId = { kind: "workflow-run", id: "dep-pipeline" };
    await facade.writeTreePreservingPrefix(
      { kind: "supervisor" },
      repoId,
      "refs/heads/main",
      {
        preservePrefix: "runs/r-1/events/",
        merge: async () => ({ "runs/r-1/events/0.json": "{}" }),
        message: "first",
      },
    );
    // Yield to the microtask queue so the push's `enter` log lands.
    // With a serialised wrap the write would not resolve until
    // `exit`; pipelining is the property under test, so we assert
    // the write returned while the push is still parked inside
    // packClient.push.
    await new Promise((r) => setTimeout(r, 0));
    expect(pushOrder).toEqual(["enter"]);
    resolvePush();
    await facade.flushWorkflowRunPushes(repoId, "refs/heads/main");
    expect(pushOrder).toEqual(["enter", "exit"]);
  });

  test("a burst of writes against the same (repoId, ref) coalesces into at most 2 pushes", async () => {
    // The coalescing invariant: while a push is in flight, follow-on
    // writes mark the slot as dirty rather than enqueueing a new
    // push. After the in-flight push exits, the loop runs one more
    // push that captures whichever commits arrived during the
    // window. This collapses N hub-ack round-trips into 2 for a
    // burst of N back-to-back writes, which is the load-bearing
    // throughput win for the fifo-mail load test.
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    registry.record("dep-burst", "agent-burst@example.com");
    let resolveFirst: () => void = () => {
      throw new Error("test: first gate not captured");
    };
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let pushCount = 0;
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        async push() {
          const idx = pushCount;
          pushCount += 1;
          if (idx === 0) await firstGate;
        },
      },
      registry,
    });

    const repoId: RepoId = { kind: "workflow-run", id: "dep-burst" };
    // Five back-to-back writes. The first triggers a push; the next
    // four land while the first push is in flight and all flip the
    // slot's `dirty` flag, but only one coalesced follow-up push
    // runs after the first exits.
    for (let i = 0; i < 5; i += 1) {
      await facade.writeTreePreservingPrefix(
        { kind: "supervisor" },
        repoId,
        "refs/heads/main",
        {
          preservePrefix: "runs/r-1/events/",
          merge: async () => ({
            [`runs/r-1/events/${String(i)}.json`]: "{}",
          }),
          message: `write-${String(i)}`,
        },
      );
    }
    expect(pushCount).toBe(1);
    resolveFirst();
    await facade.flushWorkflowRunPushes(repoId, "refs/heads/main");
    // First push covered write 0 (the only commit landed when it
    // started); the four follow-up writes coalesced into ONE
    // additional push regardless of count.
    expect(pushCount).toBe(2);
  });

  test("a failed pipelined push surfaces on the next writeTreePreservingPrefix call", async () => {
    // The facade swallows the failed push at fire time but latches
    // the error on the per-(repoId, ref) chain; the next
    // writeTreePreservingPrefix on the same (repoId, ref) re-throws
    // it. The defensive-coding rule says errors must surface; this
    // is how they surface from a pipelined writer.
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    registry.record("dep-fail", "agent-fail@example.com");
    let pushCount = 0;
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        async push() {
          pushCount += 1;
          if (pushCount === 1) {
            throw new Error("hub_rejected: non_fast_forward");
          }
        },
      },
      registry,
    });
    const repoId: RepoId = { kind: "workflow-run", id: "dep-fail" };
    await facade.writeTreePreservingPrefix(
      { kind: "supervisor" },
      repoId,
      "refs/heads/main",
      {
        preservePrefix: "runs/r/events/",
        merge: async () => ({ "runs/r/events/0.json": "{}" }),
        message: "first",
      },
    );
    // Wait for the failed push to settle on the chain without
    // consuming the latched error; flush would also surface the
    // error, but the contract being pinned here is that the NEXT
    // writeTreePreservingPrefix surfaces it -- ordinary supervisor
    // code does not call flush between writes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      facade.writeTreePreservingPrefix(
        { kind: "supervisor" },
        repoId,
        "refs/heads/main",
        {
          preservePrefix: "runs/r/events/",
          merge: async () => ({ "runs/r/events/1.json": "{}" }),
          message: "second",
        },
      ),
    ).rejects.toThrow(/non_fast_forward/);
  });

  test("a ceiling-exceeding run surfaces WorkflowRunPackTooLargeError through the latched-error path", async () => {
    // End-to-end across the seam: the REAL pack client trips its ceiling, the
    // facade latches the failure, and the next supervisor write re-throws it —
    // the run fails loudly instead of the sidecar OOM-killing (CL-2340).
    const src = await makeWorkflowRunRepo();
    try {
      for (let i = 0; i < 3; i += 1) await src.commit(i);
      const { store } = createRecordingUnderlyingRepoStore(src.dir);
      const registry = createDeploymentAddressRegistry();
      registry.record("agent-example-com", "a@example.com");
      const client = createWorkflowRunPackClient({
        substrate: store,
        hubLink: { pushWorkflowRunPack: () => Promise.resolve() },
        limits: { maxCommits: 1, maxObjects: 1_000_000 },
      });
      const facade = createWorkflowRunPackPushingRepoStore({
        underlying: store,
        packClient: client,
        registry,
      });
      const repoId: RepoId = { kind: "workflow-run", id: "agent-example-com" };
      await facade.writeTreePreservingPrefix(
        { kind: "supervisor" },
        repoId,
        "refs/heads/main",
        {
          preservePrefix: "runs/r-1/events/",
          merge: async () => ({ "runs/r-1/events/x.json": "{}" }),
          message: "first",
        },
      );
      await expect(
        facade.flushWorkflowRunPushes(repoId, "refs/heads/main"),
      ).rejects.toThrow(/exceeded the safety ceiling/);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  test("flushWorkflowRunPushes resolves immediately when no pushes are pending", async () => {
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: { push: () => Promise.resolve() },
      registry,
    });
    await facade.flushWorkflowRunPushes(
      { kind: "workflow-run", id: "never-touched" },
      "refs/heads/main",
    );
  });

  test("writeTreePreservingPrefix against a non-workflow-run repo bypasses the push hook", async () => {
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    const pushed: { agentAddress: string; repoId: RepoId; ref: string }[] = [];
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        async push(opts) {
          pushed.push(opts);
        },
      },
      registry,
    });

    await facade.writeTreePreservingPrefix(
      { kind: "hub" },
      { kind: "agent-state", id: "a-1" },
      "refs/heads/deploy",
      {
        preservePrefix: "deploy/",
        merge: async () => ({ "deploy/prompt.md": "hi" }),
        message: "deploy",
      },
    );

    expect(pushed).toEqual([]);
  });

  test("workflow-run write surfaces a structured error when no agent address is registered", async () => {
    const { store } = createRecordingUnderlyingRepoStore();
    const registry = createDeploymentAddressRegistry();
    const facade = createWorkflowRunPackPushingRepoStore({
      underlying: store,
      packClient: {
        push: () => Promise.resolve(),
      },
      registry,
    });

    await expect(
      facade.writeTreePreservingPrefix(
        { kind: "supervisor" },
        { kind: "workflow-run", id: "missing-dep" },
        "refs/heads/main",
        {
          preservePrefix: "runs/r/events/",
          merge: async () => ({}),
          message: "append",
        },
      ),
    ).rejects.toThrow(/no agent address registered/);
  });
});

describe("createMultistepMailRouter", () => {
  test("tryRoute returns false when no handler is registered", () => {
    const router = createMultistepMailRouter();
    expect(
      router.tryRoute("dep@integration.interchange", new Uint8Array([1])),
    ).toBe(false);
  });

  test("a registered handler receives the inbound message and tryRoute returns true", () => {
    const router = createMultistepMailRouter();
    const received: Uint8Array[] = [];
    router.register("dep@integration.interchange", (msg) => {
      received.push(msg);
    });
    const message = new Uint8Array([1, 2, 3, 4]);
    const claimed = router.tryRoute("dep@integration.interchange", message);
    expect(claimed).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(message);
  });

  test("registration is per-address; an unrelated address falls through", () => {
    const router = createMultistepMailRouter();
    const received: Uint8Array[] = [];
    router.register("dep-a@integration.interchange", (msg) => {
      received.push(msg);
    });
    expect(
      router.tryRoute("dep-b@integration.interchange", new Uint8Array([9])),
    ).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("unregister removes the handler", () => {
    const router = createMultistepMailRouter();
    const received: Uint8Array[] = [];
    router.register("dep@integration.interchange", (msg) => {
      received.push(msg);
    });
    router.unregister("dep@integration.interchange");
    expect(
      router.tryRoute("dep@integration.interchange", new Uint8Array([1])),
    ).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("re-registering an address replaces the prior handler", () => {
    const router = createMultistepMailRouter();
    const first: Uint8Array[] = [];
    const second: Uint8Array[] = [];
    router.register("dep@integration.interchange", (msg) => {
      first.push(msg);
    });
    router.register("dep@integration.interchange", (msg) => {
      second.push(msg);
    });
    router.tryRoute("dep@integration.interchange", new Uint8Array([7]));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});

describe("createMultistepDrainRouter", () => {
  test("tryRoute resolves to false when no handler is registered", async () => {
    const router = createMultistepDrainRouter();
    const claimed = await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep@integration.interchange",
      deadlineMs: 1_000,
    });
    expect(claimed).toBe(false);
  });

  test("a registered handler receives the deadline and tryRoute resolves to true", async () => {
    const router = createMultistepDrainRouter();
    const received: { deadlineMs: number }[] = [];
    router.register("dep@integration.interchange", async (args) => {
      received.push({ deadlineMs: args.deadlineMs });
    });
    const claimed = await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep@integration.interchange",
      deadlineMs: 3_500,
    });
    expect(claimed).toBe(true);
    expect(received).toEqual([{ deadlineMs: 3_500 }]);
  });

  test("registration is per-address; an unrelated address falls through", async () => {
    const router = createMultistepDrainRouter();
    const received: number[] = [];
    router.register("dep-a@integration.interchange", async (args) => {
      received.push(args.deadlineMs);
    });
    const claimed = await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep-b@integration.interchange",
      deadlineMs: 9_000,
    });
    expect(claimed).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("unregister removes the handler", async () => {
    const router = createMultistepDrainRouter();
    const received: number[] = [];
    router.register("dep@integration.interchange", async (args) => {
      received.push(args.deadlineMs);
    });
    router.unregister("dep@integration.interchange");
    const claimed = await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep@integration.interchange",
      deadlineMs: 1_000,
    });
    expect(claimed).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("re-registering an address replaces the prior handler", async () => {
    const router = createMultistepDrainRouter();
    const first: number[] = [];
    const second: number[] = [];
    router.register("dep@integration.interchange", async (args) => {
      first.push(args.deadlineMs);
    });
    router.register("dep@integration.interchange", async (args) => {
      second.push(args.deadlineMs);
    });
    await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep@integration.interchange",
      deadlineMs: 4_200,
    });
    expect(first).toHaveLength(0);
    expect(second).toEqual([4_200]);
  });

  test("handler rejection propagates through tryRoute", async () => {
    const router = createMultistepDrainRouter();
    router.register("dep@integration.interchange", async () => {
      throw new Error("supervisor.drain failed");
    });
    await expect(
      router.tryRoute({
        type: "drain.deliver",
        agentAddress: "dep@integration.interchange",
        deadlineMs: 1_000,
      }),
    ).rejects.toThrow(/supervisor\.drain failed/);
  });

  test("drain.deliver for a never-registered deployment id drops cleanly without throwing", async () => {
    // Pins the defensive contract for an inbound drain.deliver frame
    // that names a deploymentId the sidecar's supervisor never spawned
    // (e.g. an in-flight frame outracing the deploy ack, or a hub-side
    // stale-state retry). The router must not throw; the hub-link's
    // handleDrainDeliver then logs and drops, leaving sibling
    // deployments unaffected.
    const router = createMultistepDrainRouter();
    router.register("dep-known@integration.interchange", async () => {
      throw new Error("known handler must not be invoked");
    });
    const claimed = await router.tryRoute({
      type: "drain.deliver",
      agentAddress: "dep-unknown@integration.interchange",
      deadlineMs: 1_000,
    });
    expect(claimed).toBe(false);
  });
});

describe("createMultistepSignalRouter", () => {
  test("tryRoute resolves to false when no handler is registered", async () => {
    const router = createMultistepSignalRouter();
    const claimed = await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep@integration.interchange",
      runId: "run-1",
      signalName: "approve",
      signalId: "sig-1",
      payload: { ok: true },
    });
    expect(claimed).toBe(false);
  });

  test("a registered handler receives the signal and tryRoute resolves to true", async () => {
    const router = createMultistepSignalRouter();
    const received: {
      runId: string;
      signalName: string;
      signalId: string;
      payload: unknown;
    }[] = [];
    router.register("dep@integration.interchange", async (args) => {
      received.push(args);
    });
    const claimed = await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep@integration.interchange",
      runId: "run-42",
      signalName: "approve",
      signalId: "sig-42",
      payload: { ok: true },
    });
    expect(claimed).toBe(true);
    expect(received).toEqual([
      {
        runId: "run-42",
        signalName: "approve",
        signalId: "sig-42",
        payload: { ok: true },
      },
    ]);
  });

  test("registration is per-address; an unrelated address falls through", async () => {
    const router = createMultistepSignalRouter();
    const received: string[] = [];
    router.register("dep-a@integration.interchange", async (args) => {
      received.push(args.signalId);
    });
    const claimed = await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep-b@integration.interchange",
      runId: "run-1",
      signalName: "approve",
      signalId: "sig-1",
      payload: null,
    });
    expect(claimed).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("unregister removes the handler", async () => {
    const router = createMultistepSignalRouter();
    const received: string[] = [];
    router.register("dep@integration.interchange", async (args) => {
      received.push(args.signalId);
    });
    router.unregister("dep@integration.interchange");
    const claimed = await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep@integration.interchange",
      runId: "run-1",
      signalName: "approve",
      signalId: "sig-1",
      payload: null,
    });
    expect(claimed).toBe(false);
    expect(received).toHaveLength(0);
  });

  test("re-registering an address replaces the prior handler", async () => {
    // Pins the contract that drives the "stale-cohort signal" edge
    // case. A signal frame in flight while the deploy router re-binds
    // the deployment address (the only legitimate path that swaps the
    // handler today) must route to the most-recently-registered
    // handler; the prior cohort's handler is unreachable once
    // replaced. The router does not carry a cohortId on the wire, so
    // "live registration wins" is the contract that captures the
    // intent.
    const router = createMultistepSignalRouter();
    const first: string[] = [];
    const second: string[] = [];
    router.register("dep@integration.interchange", async (args) => {
      first.push(args.signalId);
    });
    router.register("dep@integration.interchange", async (args) => {
      second.push(args.signalId);
    });
    await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep@integration.interchange",
      runId: "run-1",
      signalName: "approve",
      signalId: "sig-late",
      payload: null,
    });
    expect(first).toHaveLength(0);
    expect(second).toEqual(["sig-late"]);
  });

  test("handler rejection propagates through tryRoute", async () => {
    const router = createMultistepSignalRouter();
    router.register("dep@integration.interchange", async () => {
      throw new Error("supervisor.deliverSignal failed");
    });
    await expect(
      router.tryRoute({
        type: "signal.deliver",
        agentAddress: "dep@integration.interchange",
        runId: "run-1",
        signalName: "approve",
        signalId: "sig-1",
        payload: null,
      }),
    ).rejects.toThrow(/supervisor\.deliverSignal failed/);
  });

  test("signal.deliver for a never-registered deployment id drops cleanly without throwing", async () => {
    // Pins the defensive contract for an inbound signal.deliver frame
    // that names a deploymentId the sidecar's supervisor never spawned
    // (e.g. an in-flight frame outracing the deploy ack, or a hub-side
    // stale-state retry). The router must not throw; the hub-link's
    // handleSignalDeliver then logs and drops, leaving sibling
    // deployments unaffected.
    const router = createMultistepSignalRouter();
    router.register("dep-known@integration.interchange", async () => {
      throw new Error("known handler must not be invoked");
    });
    const claimed = await router.tryRoute({
      type: "signal.deliver",
      agentAddress: "dep-unknown@integration.interchange",
      runId: "run-1",
      signalName: "approve",
      signalId: "sig-1",
      payload: null,
    });
    expect(claimed).toBe(false);
  });
});
