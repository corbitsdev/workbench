// Proves the warm single-step agent's conversation is DURABLE across a
// child respawn (CL-2345 Phase 2): a store mirrors its turns to the
// workflow-run substrate, and a freshly-built store (the respawn rebuild)
// restores them from the substrate before its agent's reactor loads.
//
// This is a REAL-SEAM test. It drives the production WRITE path
// (`createDurableConversationStore` -> `mirrorToSubstrate` ->
// `appendWalEntry`/`writeCheckpoint` plus the
// `mirroredBoundaryCount`/`mirroredTurnCount`/`checkpointBoundarySeq`
// bookkeeping and the CHECKPOINT_INTERVAL compaction) and the production READ
// path (`reconstructDurableConversation` folding `checkpoint.json` +
// boundary-keyed `wal/<bucket>/<seq>.json`) against the SAME on-disk substrate,
// so every assertion is a genuine writer->reader round-trip, not a hand-written
// blob fed back to the reader.
//
// LEAK-IMMUNITY. This package's `test` script is non-isolated, and
// `default-harness.test.ts` registers a process-global `mock.module` for
// `@workbench/storage-isogit` (a no-op stub) and `@intx/harness`. Those
// bindings leak into this file. To stay immune we mock BOTH specifiers HERE
// with real-enough substitutes: a STATEFUL in-memory `ContextStore` (so the
// writer's `load()`/`writeTurns()`/`writeMetadata()`/`setConnectorState()`
// actually persist within a store instance, instead of the no-op stub that
// makes `load()` always return empty) and a connector router whose `restore`
// is observable. Both are true module boundaries, which AGENTS.md permits for
// mocking. The substrate, the WAL/checkpoint layout, and the bookkeeping are
// all real. The in-memory store fake is a strict superset of the no-op stub,
// so whichever `mock.module` registration wins the process-global race, this
// file and `default-harness.test.ts` both see a compatible binding (verified:
// the full non-isolated suite is green). The local isogit store is the warm
// agent's FAST per-respawn copy, not the durability mechanism under test --
// the substrate is -- so faking it does not hollow the round-trip.

import { describe, test, expect, afterAll, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Principal, RepoId, RepoStore } from "@workbench/hub-sessions";
import type {
  ConnectorThreadState,
  ConversationTurn,
  PendingOperation,
} from "@intx/types/runtime";
import { WORKFLOW_RUN_AGENT_STATE_PREFIX } from "@workbench/hub-sessions";

// Stateful in-memory ContextStore so the production writer's reads
// (`load()`) reflect its writes (`writeTurns`/`writeMetadata`/
// `setConnectorState`) within a store instance. The no-op stub
// `default-harness.test.ts` leaks would make `load()` always return empty,
// silently hollowing every round-trip; this fake is the leak-immune real
// boundary the writer drives.
type StoreState = {
  turns: ConversationTurn[];
  pendingOperations: unknown[];
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  };
  connectorState: ConnectorThreadState | null;
};

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: async () => {
    const s: StoreState = {
      turns: [],
      pendingOperations: [],
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      connectorState: null,
    };
    return {
      type: "isogit",
      load: async () => ({
        turns: s.turns,
        pendingOperations: s.pendingOperations,
        tokenUsage: s.tokenUsage,
        connectorState: s.connectorState,
      }),
      peekTurns: () => s.turns,
      loadMetadata: async () => ({
        pendingOperations: s.pendingOperations,
        tokenUsage: s.tokenUsage,
        connectorState: s.connectorState,
      }),
      writeTurns: async (turns: ConversationTurn[]) => {
        s.turns = turns;
      },
      writeMetadata: async (m: {
        pendingOperations: unknown[];
        tokenUsage: StoreState["tokenUsage"];
      }) => {
        s.pendingOperations = m.pendingOperations;
        s.tokenUsage = m.tokenUsage;
      },
      setConnectorState: (state: ConnectorThreadState | null) => {
        s.connectorState = state;
      },
      commit: async () => ({}),
    };
  },
  createMailAuditStore: async () => ({ type: "mail-audit" }),
}));

mock.module("@intx/harness", () => ({
  createConnectorRouter: (_opts: { onStateChanged: () => void }) => ({
    restore: (_state: ConnectorThreadState | null) => {},
  }),
}));

import * as mod from "./conversation-state";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function makeDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `conv-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

const REPO_ID: RepoId = { kind: "workflow-run", id: "run-repo-warm" };
const REF = "refs/heads/main";
const PRINCIPAL: Principal = {
  kind: "workflow-process",
  deploymentId: "ses_warm",
} as unknown as Principal;
const signer = async (): Promise<string> => "test-signature";

/**
 * On-disk substrate honoring the `writeTreePreservingPrefix` contract the
 * conversation mirror depends on: `getRepoDir` returns a stable repo dir;
 * `writeTreePreservingPrefix` recursively clears the preserve-prefix subtree,
 * passes its surviving DIRECT CHILDREN to `merge`, and writes the merge's
 * returned files back under the repo dir. Files outside the prefix are left
 * untouched, mirroring the supervisor's real proxy substrate.
 */
function createOnDiskSubstrate(repoDir: string): RepoStore {
  async function readDirectChildren(
    prefixAbs: string,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    let entries: string[];
    try {
      entries = await fs.readdir(prefixAbs);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(prefixAbs, entry);
      const stat = await fs.stat(full);
      if (stat.isFile()) {
        const rel = path.relative(repoDir, full).split(path.sep).join("/");
        out.set(rel, await fs.readFile(full));
      }
    }
    return out;
  }

  const stub: Partial<RepoStore> = {
    getRepoDir(_repoId: RepoId): string {
      return repoDir;
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      const prefix = args.preservePrefix;
      const prefixAbs = path.join(repoDir, prefix);
      const existing = await readDirectChildren(prefixAbs);
      const merged = await args.merge(existing);
      // clearPrefix: drop the whole preserve-prefix subtree, then write the
      // returned set. Omitting a path from the merge result deletes it.
      await fs.rm(prefixAbs, { recursive: true, force: true });
      for (const [rel, bytes] of Object.entries(merged)) {
        const dest = path.join(repoDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const data =
          typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
        await fs.writeFile(dest, data);
      }
      return { commitSha: "on-disk-sha", newlyTerminalRuns: [] };
    },
  };

  return new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(`test substrate: ${String(prop)} not implemented`);
      };
    },
  });
}

function turn(role: "user" | "assistant", text: string): ConversationTurn {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 1700000000,
  };
}

function usage(input: number): StoreState["tokenUsage"] {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function pending(correlationId: string): PendingOperation {
  return {
    correlationId,
    kind: "approval",
    registeredAt: 1700000000,
    gateId: "gate-1",
  };
}

function connectorState(lastMessageId: string): ConnectorThreadState {
  return {
    threadRoot: "root-1",
    lastMessageId,
    replyTo: "reply-1",
    cc: [],
  };
}

function agentStateDirOf(repoDir: string, key: string): string {
  return path.join(
    repoDir,
    WORKFLOW_RUN_AGENT_STATE_PREFIX,
    encodeURIComponent(key),
  );
}

function makeRegistry(
  repoDir: string,
  dataDir: string,
): mod.DurableConversationRegistry {
  return mod.createDurableConversationRegistry({
    dataDir,
    workflowRunRepoId: REPO_ID,
    workflowRunRef: REF,
    substrate: createOnDiskSubstrate(repoDir),
    principal: PRINCIPAL,
    signer,
  });
}

/**
 * Drive one warm-agent mirror boundary through the REAL store: write the
 * boundary's metadata + connector state, append its new turns, commit the
 * local store, then mirror to the substrate. Mirrors what `onRunBoundary`
 * does after a message settles.
 */
async function mirrorBoundary(
  store: mod.DurableConversationStore,
  allTurns: ConversationTurn[],
  metadata: {
    pendingOperations: PendingOperation[];
    tokenUsage: StoreState["tokenUsage"];
    connectorState: ConnectorThreadState | null;
  },
): Promise<void> {
  await store.storage.writeTurns(allTurns);
  store.storage.setConnectorState(metadata.connectorState);
  await store.storage.writeMetadata({
    pendingOperations: metadata.pendingOperations,
    tokenUsage: metadata.tokenUsage,
  });
  await store.storage.commit({ message: "turn" });
  await store.mirrorToSubstrate();
}

describe("durable conversation warm-keep durability", () => {
  test("write -> respawn -> restore round-trip across two boundaries (real writer + real reader)", async () => {
    const repoDir = await makeDir("roundtrip");
    const dataDir = await makeDir("roundtrip-data");
    const KEY = "draft-step";

    // First child: acquire builds the store + restores (no-op, first run).
    const writer = await makeRegistry(repoDir, dataDir).acquire(KEY);

    // Boundary 0: first message adds two turns + advances metadata.
    const afterB0 = [turn("user", "hello"), turn("assistant", "hi there")];
    await mirrorBoundary(writer, afterB0, {
      pendingOperations: [pending("op-a")],
      tokenUsage: usage(10),
      connectorState: null,
    });

    // Boundary 1: second message adds two more turns + advances metadata.
    const afterB1 = [
      ...afterB0,
      turn("user", "and again"),
      turn("assistant", "still here"),
    ];
    const finalConnector = connectorState("msg-3");
    await mirrorBoundary(writer, afterB1, {
      pendingOperations: [pending("op-a"), pending("op-b")],
      tokenUsage: usage(25),
      connectorState: finalConnector,
    });

    // Respawn: a FRESH registry/store against the SAME substrate dir (the
    // child's address space is gone; the substrate is the only durable copy).
    const reborn = await makeRegistry(
      repoDir,
      await makeDir("roundtrip-data2"),
    ).acquire(KEY);
    const restored = await reborn.storage.load();

    // Turns restored exactly, in order, no loss/dup.
    expect(restored.turns).toEqual(afterB1);
    // Latest metadata (boundary 1's) restored, not boundary 0's.
    expect(restored.pendingOperations).toEqual([
      pending("op-a"),
      pending("op-b"),
    ]);
    expect(restored.tokenUsage).toEqual(usage(25));
    expect(restored.connectorState).toEqual(finalConnector);

    // And the reborn store resumes appending at the right boundary seq: a
    // third boundary must NOT re-commit the prior two (no seq gap/dup on a
    // subsequent reconstruct).
    const afterB2 = [...afterB1, turn("user", "third")];
    await mirrorBoundary(reborn, afterB2, {
      pendingOperations: [],
      tokenUsage: usage(30),
      connectorState: finalConnector,
    });
    const afterThird = await mod.reconstructDurableConversation(
      agentStateDirOf(repoDir, KEY),
      KEY,
    );
    expect(afterThird?.turns).toEqual(afterB2);
    expect(afterThird?.boundaryCount).toBe(3);
    expect(afterThird?.totalTurns).toBe(5);
  });

  test("compaction past CHECKPOINT_INTERVAL writes a checkpoint folded losslessly on reconstruct", async () => {
    const repoDir = await makeDir("compact");
    const dataDir = await makeDir("compact-data");
    const KEY = "long-step";
    const store = await makeRegistry(repoDir, dataDir).acquire(KEY);

    // One turn per boundary, past the compaction interval, so a checkpoint
    // must be written and the WAL truncated.
    const BOUNDARIES = 70; // > CHECKPOINT_INTERVAL (64)
    const all: ConversationTurn[] = [];
    for (let i = 0; i < BOUNDARIES; i += 1) {
      all.push(turn("user", `m${String(i)}`));
      await mirrorBoundary(store, [...all], {
        pendingOperations: [],
        tokenUsage: usage(i),
        connectorState: null,
      });
    }

    const agentStateDir = agentStateDirOf(repoDir, KEY);
    // A checkpoint blob exists (compaction actually ran, not just WAL growth).
    const checkpointRaw = await fs.readFile(
      path.join(agentStateDir, "checkpoint.json"),
      "utf8",
    );
    const checkpoint = JSON.parse(checkpointRaw) as { turns: unknown[] };
    expect(checkpoint.turns.length).toBeGreaterThan(0);

    // The live WAL was truncated to the post-checkpoint tail (< interval),
    // proving the fold-and-truncate, not an unbounded WAL.
    const metaRaw = await fs.readFile(
      path.join(agentStateDir, "checkpoint.meta.json"),
      "utf8",
    );
    const meta = JSON.parse(metaRaw) as {
      checkpointSeq: number;
      turnCount: number;
    };
    const reconstructed = await mod.reconstructDurableConversation(
      agentStateDir,
      KEY,
    );
    expect(reconstructed).not.toBeNull();
    if (reconstructed === null) throw new Error("unreachable");
    expect(reconstructed.checkpointBoundarySeq).toBe(meta.checkpointSeq);
    expect(reconstructed.boundaryCount - meta.checkpointSeq).toBeLessThan(64);

    // Full history folds losslessly: every turn present, in order, no dup.
    expect(reconstructed.turns).toEqual(all);
    expect(reconstructed.totalTurns).toBe(BOUNDARIES);
    expect(reconstructed.boundaryCount).toBe(BOUNDARIES);
    // Latest metadata survives the fold.
    expect(reconstructed.tokenUsage).toEqual(usage(BOUNDARIES - 1));
  });

  test("turnless boundary commits latest-metadata-wins (zero new turns, changed metadata)", async () => {
    const repoDir = await makeDir("turnless");
    const dataDir = await makeDir("turnless-data");
    const KEY = "meta-step";
    const store = await makeRegistry(repoDir, dataDir).acquire(KEY);

    // Boundary 0: one turn + initial metadata.
    const turns = [turn("user", "only message")];
    await mirrorBoundary(store, turns, {
      pendingOperations: [pending("pending-x")],
      tokenUsage: usage(5),
      connectorState: null,
    });

    // Boundary 1: NO new turns, but metadata advances (e.g. a throwing send
    // that still moved tokenUsage). The turn list is byte-identical; only the
    // metadata differs from boundary 0.
    const laterConnector = connectorState("msg-9");
    await mirrorBoundary(store, turns, {
      pendingOperations: [],
      tokenUsage: usage(42),
      connectorState: laterConnector,
    });

    // Restore must yield the LATEST (boundary 1) metadata despite no turn
    // change -- the invariant the per-boundary keying exists to preserve.
    const reborn = await makeRegistry(
      repoDir,
      await makeDir("turnless-data2"),
    ).acquire(KEY);
    const restored = await reborn.storage.load();
    expect(restored.turns).toEqual(turns);
    expect(restored.pendingOperations).toEqual([]);
    expect(restored.tokenUsage).toEqual(usage(42));
    expect(restored.connectorState).toEqual(laterConnector);

    // And the turnless boundary was durably recorded as its own WAL entry.
    const reconstructed = await mod.reconstructDurableConversation(
      agentStateDirOf(repoDir, KEY),
      KEY,
    );
    expect(reconstructed?.boundaryCount).toBe(2);
    expect(reconstructed?.totalTurns).toBe(1);
  });

  test("reconstruct throws on a corrupt WAL blob the real writer would never emit", async () => {
    const repoDir = await makeDir("corrupt-wal");
    const dataDir = await makeDir("corrupt-wal-data");
    const KEY = "draft";
    const store = await makeRegistry(repoDir, dataDir).acquire(KEY);
    await mirrorBoundary(store, [turn("user", "hi")], {
      pendingOperations: [],
      tokenUsage: usage(1),
      connectorState: null,
    });

    // Corrupt the boundary-0 WAL blob the writer produced (schema-invalid:
    // `turns` must be an array). A corrupt durable copy must surface, not
    // silently start the agent fresh.
    const walBlob = path.join(
      agentStateDirOf(repoDir, KEY),
      "wal",
      "0",
      "0.json",
    );
    await fs.writeFile(
      walBlob,
      JSON.stringify({ seq: 0, turns: "not-an-array", metadata: {} }),
    );
    await expect(
      mod.reconstructDurableConversation(agentStateDirOf(repoDir, KEY), KEY),
    ).rejects.toThrow(/failed validation/);

    // Non-JSON garbage in the same blob also surfaces.
    await fs.writeFile(walBlob, "{ not json");
    await expect(
      mod.reconstructDurableConversation(agentStateDirOf(repoDir, KEY), KEY),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("reconstruct throws on a corrupt checkpoint blob", async () => {
    const repoDir = await makeDir("corrupt-ckpt");
    const dataDir = await makeDir("corrupt-ckpt-data");
    const KEY = "long";
    const store = await makeRegistry(repoDir, dataDir).acquire(KEY);
    const all: ConversationTurn[] = [];
    for (let i = 0; i < 70; i += 1) {
      all.push(turn("user", `m${String(i)}`));
      await mirrorBoundary(store, [...all], {
        pendingOperations: [],
        tokenUsage: usage(i),
        connectorState: null,
      });
    }

    // Corrupt the checkpoint the compaction wrote: turnCount no longer matches
    // the turn array, which the reader treats as an inconsistent pair.
    const agentStateDir = agentStateDirOf(repoDir, KEY);
    const meta = JSON.parse(
      await fs.readFile(
        path.join(agentStateDir, "checkpoint.meta.json"),
        "utf8",
      ),
    );
    await fs.writeFile(
      path.join(agentStateDir, "checkpoint.meta.json"),
      JSON.stringify({ ...meta, turnCount: meta.turnCount + 99 }),
    );
    await expect(
      mod.reconstructDurableConversation(agentStateDir, KEY),
    ).rejects.toThrow(/inconsistent/);
  });

  test("reconstruct returns null for a genuine first-ever run (no checkpoint, no WAL)", async () => {
    const repoDir = await makeDir("empty");
    const agentStateDir = path.join(
      repoDir,
      WORKFLOW_RUN_AGENT_STATE_PREFIX,
      "draft",
    );
    await fs.mkdir(agentStateDir, { recursive: true });
    expect(
      await mod.reconstructDurableConversation(agentStateDir, "draft"),
    ).toBeNull();
  });

  test("registry restores nothing for a genuine first-ever agent key", async () => {
    const repoDir = await makeDir("substrate2");
    const dataDir = await makeDir("regdata");
    const registry = makeRegistry(repoDir, dataDir);

    const store = await registry.acquire("fresh-step");
    const loaded = await store.storage.load();
    expect(loaded.turns).toEqual([]);
    // The registry returns the same instance on re-acquire (one store per key).
    expect(await registry.acquire("fresh-step")).toBe(store);
    expect(registry.get("fresh-step")).toBe(store);
  });

  test("get throws for a key the run-boundary mirror reaches before acquire", () => {
    const registry = makeRegistry("/unused", "/data");
    expect(() => registry.get("never-acquired")).toThrow(
      /no durable conversation store/,
    );
  });
});
