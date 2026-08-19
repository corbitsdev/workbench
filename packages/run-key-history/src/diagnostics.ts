// Read side of `run_key_history`. The listener (./listener.ts) and the
// parked repair (./reconnect.ts, CL-6281) both write or would write
// against this table; nothing before this module ever read it back for
// a human. This is purely diagnostic — it never writes `run_key_history`
// or `workflow_run`, unlike `./reconnect.ts`, which this module does not
// import or extend.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "@intx/db";
import { liveWorkflowRunStatuses, workflowRun } from "@intx/db/schema";
import { runKeyHistory } from "./schema";

export type RunKeyLifecycleEntry = {
  readonly publicKey: string;
  readonly recordedAt: Date;
  readonly supersededAt: Date | null;
};

/**
 * The full ordered key history for one run address, oldest first. Empty
 * when `./listener.ts` has never observed an `agent.deploy.ack` for this
 * address — a pre-existing run, or a deploy this package predates.
 */
export async function getRunKeyLifecycle(
  db: DB["db"],
  runAddress: string,
): Promise<readonly RunKeyLifecycleEntry[]> {
  return db
    .select({
      publicKey: runKeyHistory.publicKey,
      recordedAt: runKeyHistory.recordedAt,
      supersededAt: runKeyHistory.supersededAt,
    })
    .from(runKeyHistory)
    .where(eq(runKeyHistory.runAddress, runAddress))
    .orderBy(runKeyHistory.recordedAt);
}

/**
 * A run's identity state, distinguishing the reasons a reconnect
 * challenge can fail so a "failed"/"cancelled" run failing its challenge
 * (correct, per `liveWorkflowRunStatuses`) never reads the same as a
 * live run whose recorded key has genuinely diverged (a fault).
 *
 * - "retired": the platform's own liveness gate has already retired this
 *   run. A challenge failure here is expected behavior, not a fault.
 * - "unacknowledged": the run is live but `./listener.ts` has never
 *   recorded an ack for its address — the platform's own deploy-to-ack
 *   window, or a deploy that predates this package.
 * - "diverged": the run is live, an ack was recorded, and the recorded
 *   key disagrees with `workflow_run.public_key` — the CL-6281 gap this
 *   package's `./reconnect.ts` repairs but this module only reports.
 * - "in_sync": the run is live and the recorded key matches
 *   `workflow_run.public_key`.
 */
export type RunIdentityState =
  "retired" | "unacknowledged" | "diverged" | "in_sync";

export type RunIdentityStatus = {
  readonly runAddress: string;
  readonly tenantId: string;
  readonly sidecarId: string | null;
  readonly workflowRunStatus: string;
  readonly isLive: boolean;
  readonly recordedKey: string | null;
  readonly platformKey: string | null;
  readonly state: RunIdentityState;
};

function isLiveStatus(status: string): boolean {
  return liveWorkflowRunStatuses.some((live) => live === status);
}

function classify(
  isLive: boolean,
  recordedKey: string | null,
  platformKey: string | null,
): RunIdentityState {
  if (!isLive) return "retired";
  if (recordedKey === null) return "unacknowledged";
  if (recordedKey !== platformKey) return "diverged";
  return "in_sync";
}

async function currentKeysByAddress(
  db: DB["db"],
  addresses: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (addresses.length === 0) return new Map();
  const rows = await db
    .select({
      runAddress: runKeyHistory.runAddress,
      publicKey: runKeyHistory.publicKey,
    })
    .from(runKeyHistory)
    .where(
      and(
        inArray(runKeyHistory.runAddress, [...addresses]),
        isNull(runKeyHistory.supersededAt),
      ),
    );
  return new Map(rows.map((row) => [row.runAddress, row.publicKey]));
}

/**
 * One run's identity status, or `null` when `runAddress` names no
 * `workflow_run` row at all (not a run address, or the row was deleted).
 */
export async function getRunIdentityStatus(
  db: DB["db"],
  runAddress: string,
): Promise<RunIdentityStatus | null> {
  const [run] = await db
    .select({
      tenantId: workflowRun.tenantId,
      sidecarId: workflowRun.sidecarId,
      status: workflowRun.status,
      publicKey: workflowRun.publicKey,
    })
    .from(workflowRun)
    .where(eq(workflowRun.address, runAddress))
    .limit(1);
  if (run === undefined) return null;

  const currentKeys = await currentKeysByAddress(db, [runAddress]);
  const recordedKey = currentKeys.get(runAddress) ?? null;
  const isLive = isLiveStatus(run.status);
  return {
    runAddress,
    tenantId: run.tenantId,
    sidecarId: run.sidecarId,
    workflowRunStatus: run.status,
    isLive,
    recordedKey,
    platformKey: run.publicKey,
    state: classify(isLive, recordedKey, run.publicKey),
  };
}

export type RunIdentityStateCounts = {
  readonly retired: number;
  readonly unacknowledged: number;
  readonly diverged: number;
  readonly inSync: number;
};

export type RunIdentityScope = {
  readonly tenantId: string;
  readonly sidecarId?: string;
};

/**
 * Counts every addressed run in scope by `RunIdentityState`, for a
 * tenant (and optionally one sidecar within it) — the "13 runs failing
 * their reconnect challenge" incident, surfaced as a number instead of
 * grepped log lines.
 */
export async function countRunIdentityStates(
  db: DB["db"],
  scope: RunIdentityScope,
): Promise<RunIdentityStateCounts> {
  const conditions = [eq(workflowRun.tenantId, scope.tenantId)];
  if (scope.sidecarId !== undefined) {
    conditions.push(eq(workflowRun.sidecarId, scope.sidecarId));
  }

  const runs = await db
    .select({
      address: workflowRun.address,
      status: workflowRun.status,
      publicKey: workflowRun.publicKey,
    })
    .from(workflowRun)
    .where(and(...conditions));

  const addressedRuns = runs.filter(
    (run): run is typeof run & { address: string } => run.address !== null,
  );

  const currentKeys = await currentKeysByAddress(
    db,
    addressedRuns.map((run) => run.address),
  );

  const counts = { retired: 0, unacknowledged: 0, diverged: 0, inSync: 0 };

  for (const run of addressedRuns) {
    const state = classify(
      isLiveStatus(run.status),
      currentKeys.get(run.address) ?? null,
      run.publicKey,
    );
    switch (state) {
      case "retired":
        counts.retired += 1;
        break;
      case "unacknowledged":
        counts.unacknowledged += 1;
        break;
      case "diverged":
        counts.diverged += 1;
        break;
      case "in_sync":
        counts.inSync += 1;
        break;
    }
  }

  return counts;
}
