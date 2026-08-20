// Covers the durable per-run effect ledger over the workflow-run
// substrate: miss/hit, durability across adapter rebuilds, envelope
// fail-closed paths, and kind-handler append-only semantics.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import { hexEncode } from "@intx/types";
import type { KeyPair } from "@intx/types/runtime";
import {
  createRepoStore,
  workflowRunKindHandler,
  WORKFLOW_RUN_GITIGNORE_PATH,
} from "@intx/hub-sessions";
import type {
  AuthorizeFn,
  KindHandler,
  Principal,
  RepoId,
  ValidatePushResult,
} from "@intx/hub-sessions";

import { createWorkflowRunEffectLedger } from "./effect-ledger";

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

const REF = "refs/heads/main";
const allowAll: AuthorizeFn = () => ({ allowed: true });

// Adapter smoke tests target ledger behavior, not the kind handler's
// schema. A permissive agent-state handler stands in — same pattern as
// the blob substrate adapter tests.
const permissiveHandler: KindHandler = {
  kind: "agent-state",
  directoryPrefix: "effect-ledger-test",
  validatePush(): ValidatePushResult {
    return { ok: true };
  },
  onRefUpdated() {
    /* no-op */
  },
};

const TEST_PRINCIPAL: Principal = { kind: "test" };

async function makeLedger(runId: string, deploymentId: string) {
  const dataDir = await makeTempDir("effect-ledger-adapter-");
  const repoId: RepoId = { kind: "agent-state", id: deploymentId };
  const substrate = createRepoStore({
    dataDir,
    signingKey,
    handlers: { "agent-state": permissiveHandler },
    authorize: allowAll,
  });
  const ledger = createWorkflowRunEffectLedger({
    substrate,
    repoId,
    principal: TEST_PRINCIPAL,
    runId,
    ref: REF,
  });
  return { ledger, substrate, repoId, dataDir };
}

async function identityKeyHex(effectKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // ArrayBuffer-backed; Web Crypto BufferSource rejects ArrayBufferLike
    // under TS 5.9, hence the assertion.
    new TextEncoder().encode(effectKey) as Uint8Array<ArrayBuffer>,
  );
  return hexEncode(new Uint8Array(digest));
}

describe("createWorkflowRunEffectLedger", () => {
  test("lookup returns undefined on a miss", async () => {
    const { ledger } = await makeLedger("run-miss", "dep-miss");
    expect(await ledger.lookup("never-recorded")).toBeUndefined();
  });

  test("record then lookup returns the output", async () => {
    const { ledger } = await makeLedger("run-hit", "dep-hit");
    await ledger.record("effect-key-1", { ok: true, n: 7 });
    expect(await ledger.lookup("effect-key-1")).toEqual({
      output: { ok: true, n: 7 },
    });
  });

  test("record is durable across a fresh adapter on the same substrate", async () => {
    const runId = "run-durable";
    const { substrate, repoId } = await makeLedger(runId, "dep-durable");
    const first = createWorkflowRunEffectLedger({
      substrate,
      repoId,
      principal: TEST_PRINCIPAL,
      runId,
      ref: REF,
    });
    await first.record("effect-key-durable", "persisted-value");

    // Fresh adapter — simulates a child process restart that rebuilds the
    // ledger against the same workflow-run repo.
    const second = createWorkflowRunEffectLedger({
      substrate,
      repoId,
      principal: TEST_PRINCIPAL,
      runId,
      ref: REF,
    });
    expect(await second.lookup("effect-key-durable")).toEqual({
      output: "persisted-value",
    });
  });

  test("distinct effect keys do not collide", async () => {
    const { ledger } = await makeLedger("run-multi", "dep-multi");
    await ledger.record("key-a", "A");
    await ledger.record("key-b", "B");
    expect(await ledger.lookup("key-a")).toEqual({ output: "A" });
    expect(await ledger.lookup("key-b")).toEqual({ output: "B" });
  });

  test("record fails closed when output cannot form a {output} envelope", async () => {
    const { ledger } = await makeLedger(
      "run-unserializable",
      "dep-unserializable",
    );
    await expect(ledger.record("undef-key", undefined)).rejects.toThrow(
      /cannot serialize output/,
    );
    // Miss stays a miss — no bare `{}` was written.
    expect(await ledger.lookup("undef-key")).toBeUndefined();
  });

  test("lookup throws when the on-disk entry is not a {output} envelope", async () => {
    const runId = "run-malformed";
    const { ledger, substrate, repoId } = await makeLedger(
      runId,
      "dep-malformed",
    );
    const key = await identityKeyHex("bad-envelope");
    await substrate.writeTreePreservingPrefix(TEST_PRINCIPAL, repoId, REF, {
      preservePrefix: `runs/${runId}/blobs/`,
      merge: async (existing) => {
        const files: Record<string, string | Uint8Array> = {};
        for (const [k, v] of existing) files[k] = v;
        files[`runs/${runId}/blobs/${key}`] = JSON.stringify({
          notOutput: true,
        });
        return files;
      },
      message: "seed malformed effect entry",
    });
    await expect(ledger.lookup("bad-envelope")).rejects.toThrow(
      /is not a \{output\} envelope/,
    );
  });

  test("kind-handler path: identical re-record is idempotent; divergent fails closed", async () => {
    const dataDir = await makeTempDir("effect-ledger-immutable-");
    const repoId: RepoId = { kind: "workflow-run", id: "dep-immutable" };
    const principal: Principal = { kind: "supervisor" };
    const runId = "run-immutable";
    const substrate = createRepoStore({
      dataDir,
      signingKey,
      handlers: { "workflow-run": workflowRunKindHandler },
      authorize: allowAll,
    });
    // Kind handler requires every run dir to carry events/; seed a
    // RunStarted so the first effect write has a valid prior layout.
    await substrate.writeTree({ kind: "hub" }, repoId, REF, {
      files: {
        [WORKFLOW_RUN_GITIGNORE_PATH]: "",
        [`runs/${runId}/events/0.json`]: JSON.stringify({
          type: "RunStarted",
          seq: 0,
          at: "2026-01-01T00:00:00.000Z",
          runId,
          definitionHash: "test-hash",
          trigger: { type: "manual", payload: null },
        }),
      },
      message: "genesis with run events",
    });
    const ledger = createWorkflowRunEffectLedger({
      substrate,
      repoId,
      principal,
      runId,
      ref: REF,
    });

    await ledger.record("once-key", { first: true });
    // Identical re-record: kind handler's append-only compare accepts it.
    await ledger.record("once-key", { first: true });
    expect(await ledger.lookup("once-key")).toEqual({
      output: { first: true },
    });

    await expect(ledger.record("once-key", { first: false })).rejects.toThrow(
      /immutable|diverge|append-only|path_violation/,
    );
    // Original value is preserved — the divergent write must not land.
    expect(await ledger.lookup("once-key")).toEqual({
      output: { first: true },
    });
  });
});
