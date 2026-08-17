// Regression tests for the parked-approval recovery bindings (ported from
// upstream Interchange's sidecar; see parked-approvals.ts). Before the
// port, a sidecar restart crashed every restored workflow-child whose run
// was parked on an ask-approval: the child's re-registration enumeration
// found the park but had no `loadParkedApproval` binding wired and threw,
// killing the deployment at boot.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { PendingOperation } from "@intx/types/runtime";

import {
  findApprovalSnapshot,
  readColdParkedApprovalSnapshot,
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
