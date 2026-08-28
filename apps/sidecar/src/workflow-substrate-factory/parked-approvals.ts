// Parked-approval recovery reads, ported from upstream Interchange's
// sidecar (apps/sidecar/src/workflow-substrate-factory.ts) — the
// durable-storage half of the child's
// `loadParkedApproval` / `readParkedApprovalOps` bindings. The child owns
// enumeration (it walks its reduced run state for `awaiting-signal` steps
// on control-plane channels); the snapshot lives in per-step durable
// storage whose on-disk layout (cold per-attempt isogit store vs warm
// substrate-mirrored conversation state) this host owns, so the reads
// live here. Unwired, every sidecar restart crashed each restored
// workflow-child whose run was parked on an ask-approval.
import fs from "node:fs";
import path from "node:path";
import type { RepoStore } from "@intx/hub-sessions";
import { WORKFLOW_RUN_AGENT_STATE_PREFIX } from "@intx/hub-sessions";
import type { RepoId } from "@intx/hub-sessions";
import { createIsogitStore } from "@intx/storage-isogit/node";
import type { ApprovalSnapshot, PendingOperation } from "@intx/types/runtime";
import type { ParkedApprovalOp } from "@intx/workflow";

import {
  isErrnoNotFound,
  reconstructDurableConversation,
} from "../conversation-state";
import { stepStorageRoot } from "./storage-paths";

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch (cause) {
    if (isErrnoNotFound(cause)) return false;
    throw cause;
  }
}

export function findApprovalSnapshot(
  pendingOperations: readonly PendingOperation[],
  correlationId: string,
): ApprovalSnapshot | undefined {
  return pendingOperations.find((op) => op.correlationId === correlationId)
    ?.approvalSnapshot;
}

/**
 * Read a cold (multi-step) parked step's durable pending operations from
 * its on-disk per-attempt isogit store. The store is written at suspend
 * and survives while the run is non-terminal — a parked step keeps the
 * run in-flight, so the run-completion reclamation (`cleanupRunStorage`)
 * never fires against it.
 *
 * Returns an empty list when the store directory is absent rather than
 * manufacturing an empty repo on the read path: `createIsogitStore` calls
 * `initAgentRepo`, which would `mkdir` and init a fresh repo for a
 * non-existent dir. The `directoryExists` guard keeps the read a read —
 * on an existing store `initAgentRepo` finds a repo and commits nothing,
 * so no signer is needed (`load()` never signs).
 */
export async function readColdParkedPendingOperations(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
}): Promise<PendingOperation[]> {
  const storeDir = stepStorageRoot({
    dataDir: args.dataDir,
    workflowRunRepoId: args.workflowRunRepoId,
    runId: args.runId,
    stepId: args.stepId,
    attempt: args.attempt,
  });
  if (!(await directoryExists(storeDir))) return [];
  const store = await createIsogitStore(storeDir);
  const { pendingOperations } = await store.load();
  return pendingOperations;
}

export async function readColdParkedApprovalSnapshot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
  correlationId: string;
}): Promise<ApprovalSnapshot | undefined> {
  return findApprovalSnapshot(
    await readColdParkedPendingOperations(args),
    args.correlationId,
  );
}

/**
 * Read a warm (single-step) parked agent's durable pending operations
 * from substrate state. A warm agent's pending operations live in its
 * durable conversation store, mirrored to the workflow-run substrate
 * under `agent-state/<stepId>/<workbenchId>/`.
 *
 * Reconstructs that state read-only — deliberately NOT through
 * `DurableConversationRegistry.acquire`, whose first acquire writes and
 * commits a substrate restore into the live store and would front-run
 * the warm agent's own restore ordering. A respawned child has not
 * rebuilt the live store when re-registration runs (resume re-parks
 * without re-invoking the step), so the substrate is the only place the
 * pending operations live at that moment. Returns an empty list when no
 * durable state exists for the agent. Walks every nested workbench dir
 * so a park in any room is visible.
 */
export async function readWarmParkedPendingOperations(args: {
  substrate: RepoStore;
  workflowRunRepoId: RepoId;
  stepId: string;
}): Promise<PendingOperation[]> {
  const agentStateDir = path.join(
    args.substrate.getRepoDir(args.workflowRunRepoId),
    WORKFLOW_RUN_AGENT_STATE_PREFIX,
    encodeURIComponent(args.stepId),
  );
  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(agentStateDir, { withFileTypes: true });
  } catch (cause) {
    if (isErrnoNotFound(cause)) return [];
    throw cause;
  }
  const pending: PendingOperation[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const reconstructed = await reconstructDurableConversation(
      path.join(agentStateDir, child.name),
      `${args.stepId}/${child.name}`,
    );
    if (reconstructed !== null) {
      pending.push(...reconstructed.pendingOperations);
    }
  }
  return pending;
}

export async function readWarmParkedApprovalSnapshot(args: {
  substrate: RepoStore;
  workflowRunRepoId: RepoId;
  stepId: string;
  correlationId: string;
}): Promise<ApprovalSnapshot | undefined> {
  return findApprovalSnapshot(
    await readWarmParkedPendingOperations(args),
    args.correlationId,
  );
}

/**
 * Project a parked step's durable pending operations down to the minimal
 * approval records the resume classifier needs. Filters to `approval`
 * (the only control-plane kind today) and keeps only the correlationId
 * and the optional epoch-ms deadline; the runtime reconstructs the lost
 * `SignalAwaited` from those alone, and must not see the reactor's
 * pending-operation internals.
 */
export function toParkedApprovalOps(
  pendingOperations: PendingOperation[],
): ParkedApprovalOp[] {
  return pendingOperations
    .filter((op) => op.kind === "approval")
    .map((op) => ({
      correlationId: op.correlationId,
      ...(op.timeoutAt !== undefined ? { timeoutAtMs: op.timeoutAt } : {}),
    }));
}
