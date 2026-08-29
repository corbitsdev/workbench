// Regression tests for the parked-approval recovery bindings (ported from
// upstream Interchange's sidecar; see parked-approvals.ts). Before the
// port, a sidecar restart crashed every restored workflow-child whose run
// was parked on an ask-approval: the child's re-registration enumeration
// found the park but had no `loadParkedApproval` binding wired and threw,
// killing the deployment at boot.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { RepoStore } from "@intx/hub-sessions";
import type { PendingOperation } from "@intx/types/runtime";

import {
  findApprovalSnapshot,
  readColdParkedApprovalSnapshot,
  readWarmParkedPendingOperations,
  toParkedApprovalOps,
} from "./parked-approvals";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const REPO_ID = { kind: "workflow-run" as const, id: "dep-parked-1" };

function approvalOp(correlationId: string, timeoutAt?: number) {
  return {
    kind: "approval",
    correlationId,
    approvalSnapshot: { question: `q-${correlationId}` },
    ...(timeoutAt !== undefined ? { timeoutAt } : {}),
  } as unknown as PendingOperation;
}

describe("findApprovalSnapshot", () => {
  test("returns the snapshot for the matching correlation and undefined otherwise", () => {
    const ops = [approvalOp("corr-a"), approvalOp("corr-b")];
    expect(findApprovalSnapshot(ops, "corr-b")).toEqual({
      question: "q-corr-b",
    } as never);
    expect(findApprovalSnapshot(ops, "corr-missing")).toBeUndefined();
  });
});

describe("toParkedApprovalOps", () => {
  test("keeps only approval ops, projecting correlationId and deadline", () => {
    const ops = [
      approvalOp("corr-a", 1234),
      approvalOp("corr-b"),
      { kind: "input", correlationId: "corr-c" } as unknown as PendingOperation,
    ];
    expect(toParkedApprovalOps(ops)).toEqual([
      { correlationId: "corr-a", timeoutAtMs: 1234 },
      { correlationId: "corr-b" },
    ]);
  });
});

describe("readColdParkedApprovalSnapshot", () => {
  test("an absent step store reads as no snapshot, never an init or a throw", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "parked-cold-"));
    tempDirs.push(dataDir);
    const snapshot = await readColdParkedApprovalSnapshot({
      dataDir,
      workflowRunRepoId: REPO_ID,
      runId: "run-x",
      stepId: "default",
      attempt: 1,
      correlationId: "corr-never",
    });
    expect(snapshot).toBeUndefined();
  });
});

const EMPTY_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

async function writeRoomCheckpoint(
  repoDir: string,
  stepId: string,
  workbenchId: string,
  pendingOperations: unknown[],
): Promise<void> {
  const dir = path.join(repoDir, "agent-state", stepId, workbenchId);
  await mkdir(dir, { recursive: true });
  const snapshot = {
    turns: [],
    pendingOperations,
    tokenUsage: EMPTY_TOKEN_USAGE,
    connectorState: null,
  };
  const meta = {
    checkpointSeq: 1,
    turnCount: 0,
    pendingOperations,
    tokenUsage: EMPTY_TOKEN_USAGE,
    connectorState: null,
  };
  await writeFile(path.join(dir, "checkpoint.json"), JSON.stringify(snapshot));
  await writeFile(path.join(dir, "checkpoint.meta.json"), JSON.stringify(meta));
}

describe("readWarmParkedPendingOperations", () => {
  test("collects pending ops from nested rooms and ignores a mixed agent-state blob", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "parked-warm-"));
    tempDirs.push(repoDir);
    await writeRoomCheckpoint(repoDir, "default", "chan_a", [
      approvalOp("corr-a"),
    ]);
    await writeRoomCheckpoint(repoDir, "default", "chan_b", [
      approvalOp("corr-b"),
    ]);
    await writeFile(
      path.join(repoDir, "agent-state", "default", "checkpoint.json"),
      JSON.stringify({ pendingOperations: [approvalOp("corr-legacy")] }),
    );

    const substrate = {
      getRepoDir: () => repoDir,
    } as unknown as RepoStore;

    const pending = await readWarmParkedPendingOperations({
      substrate,
      workflowRunRepoId: REPO_ID,
      stepId: "default",
    });
    const ids = pending.map((op) => op.correlationId).sort();
    expect(ids).toEqual(["corr-a", "corr-b"]);
  });
});
