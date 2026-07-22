import { getLogger } from "@intx/log";
import type { GranolaCallJobRow } from "../db/schema";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { loadRunRecord } from "../workflow-executor/run-store";

import { isTerminalRunStatus } from "../workflow-executor/run-status";
import type { StartRunInput, StartRunResult } from "./workflow-run-starter";
import type { GranolaCallJobQueue } from "./granola-call-job-queue";
import { DEFAULT_GRANOLA_LEASE_MS } from "./granola-call-job-queue";

const log = getLogger(["services", "granola-call-job-runner"]);

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

function defaultWorkerId(): string {
  return `granola-call-job-runner:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

export type TerminalRunStatus = "completed" | "failed" | "stopped";

export interface GranolaCallJobRunnerDeps {
  db: HubDb;
  queue: GranolaCallJobQueue;
  startRun: (args: StartRunInput) => Promise<StartRunResult>;
  tickIntervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  workerId?: string;
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  /** test inject */ waitForRun?: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<TerminalRunStatus>;
  /** test inject */ peekRunStatus?: (
    runId: string,
  ) => Promise<TerminalRunStatus | "running" | null>;
}

export interface GranolaCallJobRunner {
  start(): void;
  stop(): void;
  /** Drains one batch of due jobs; exported for tests so a run can be awaited
   * deterministically instead of racing the interval timer. */
  runOnce(): Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultWaitForRun(
  db: HubDb,
  pollIntervalMs: number,
  runTimeoutMs: number,
): (runId: string, signal: AbortSignal) => Promise<TerminalRunStatus> {
  return async (runId, signal) => {
    const deadline = Date.now() + runTimeoutMs;
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      const record = await loadRunRecord(db, runId);
      if (record && isTerminalRunStatus(record.status)) {
        return record.status as TerminalRunStatus;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `granola call job runner: run ${runId} timed out after ${runTimeoutMs}ms`,
        );
      }
      await sleep(pollIntervalMs, signal);
    }
  };
}

function defaultPeekRunStatus(
  db: HubDb,
): (runId: string) => Promise<TerminalRunStatus | "running" | null> {
  return async (runId) => {
    const record = await loadRunRecord(db, runId);
    if (!record) return null;
    if (isTerminalRunStatus(record.status)) {
      return record.status as TerminalRunStatus;
    }
    return "running";
  };
}

/**
 * Build the workflow trigger payload for a due job.
 *
 * Always includes `noteId`. Best-effort `tenantDomain` comes from the
 * deployment root tenant domain so classify can distinguish internal vs
 * external attendees. Empty domain is still valid — the classify tool returns
 * "unknown" rather than skipping the step.
 */
export function buildGranolaCallTriggerPayload(
  job: Pick<GranolaCallJobRow, "noteId" | "tenantId">,
  rootTenantDomain?: string,
): { noteId: string; tenantDomain?: string } {
  const domain = (rootTenantDomain ?? "").trim();
  if (domain.length === 0) {
    return { noteId: job.noteId };
  }
  return { noteId: job.noteId, tenantDomain: domain };
}

function rootTenantDomainBestEffort(): string {
  try {
    return getConfig().rootTenant.domain ?? "";
  } catch {
    // Unit tests may not boot full hub config; classify still runs with empty domain.
    return "";
  }
}

/**
 * Resolve the workflow run for a claimed job without starting a second concurrent
 * run when the unit already has an activeRunId (lease reclaim / dual-worker race).
 *
 * Retry model: queue owns retry. A terminal non-completed status → queue.fail →
 * backoff → new claim. That re-executes the full graph; artifact sourceRef and
 * fanout message_key make partial re-runs safe for side effects (LLM cost is
 * re-paid — accepted until a skip-if-artifacts-exist short-circuit ships).
 */
async function resolveRunId(
  deps: GranolaCallJobRunnerDeps,
  job: GranolaCallJobRow,
  workerId: string,
  peekRunStatus: (
    runId: string,
  ) => Promise<TerminalRunStatus | "running" | null>,
): Promise<
  | { kind: "run"; runId: string }
  | { kind: "already_terminal"; runId: string; status: TerminalRunStatus }
  | { kind: "start_failed"; message: string }
> {
  if (job.activeRunId) {
    const peek = await peekRunStatus(job.activeRunId);
    if (peek === "running") {
      log.info(
        "granola call job: attaching to existing run {noteId} run={runId}",
        { noteId: job.noteId, runId: job.activeRunId },
      );
      return { kind: "run", runId: job.activeRunId };
    }
    // Only a *successful* terminal run short-circuits. failed/stopped mean the
    // queue chose to re-claim — start a fresh run (overwrite activeRunId).
    if (peek === "completed") {
      return {
        kind: "already_terminal",
        runId: job.activeRunId,
        status: "completed",
      };
    }
    // failed | stopped | null → fall through to startRun
    if (peek === "failed" || peek === "stopped") {
      log.info(
        "granola call job: prior run {status}; starting new run {noteId}",
        { status: peek, noteId: job.noteId, priorRunId: job.activeRunId },
      );
    } else {
      log.warn(
        "granola call job: activeRunId missing from store; starting new run {runId}",
        { runId: job.activeRunId, noteId: job.noteId },
      );
    }
  }

  const result = await deps.startRun({
    kind: "granola-call",
    tenantId: job.tenantId,
    input: buildGranolaCallTriggerPayload(job, rootTenantDomainBestEffort()),
    source: "scheduler",
  });
  if (!result.ok) {
    return {
      kind: "start_failed",
      message: `startRun ${result.reason}: ${result.message}`,
    };
  }

  const stored = await deps.queue.setActiveRunId(
    job.id,
    workerId,
    result.runId,
  );
  if (!stored) {
    // Lost lease between start and persist — still return runId so this worker
    // can wait; reclaimer will also see the run if setActiveRunId raced in.
    log.warn(
      "granola call job: setActiveRunId failed after start (lease lost?) {runId}",
      { runId: result.runId, jobId: job.id },
    );
  }
  return { kind: "run", runId: result.runId };
}

async function processJob(
  deps: GranolaCallJobRunnerDeps,
  job: GranolaCallJobRow,
  waitForRun: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<TerminalRunStatus>,
  peekRunStatus: (
    runId: string,
  ) => Promise<TerminalRunStatus | "running" | null>,
  controller: AbortController,
  workerId: string,
  leaseMs: number,
  heartbeatMs: number,
): Promise<void> {
  // Heartbeat keeps the lease. On loss we stop heartbeating but do NOT abort
  // waitForRun — the workflow may still complete on the sidecar; the reclaiming
  // worker attaches via activeRunId instead of starting a second run.
  const heartbeat = setInterval(() => {
    deps.queue
      .heartbeat(job.id, workerId, leaseMs)
      .then((ok) => {
        if (!ok) {
          log.warn("granola call job: lost lease; will not re-start run {jobId}", {
            jobId: job.id,
            workerId,
          });
          clearInterval(heartbeat);
        }
      })
      .catch((err) => {
        log.warn("granola call job: heartbeat failed {jobId}", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, heartbeatMs);

  try {
    const resolved = await resolveRunId(deps, job, workerId, peekRunStatus);
    if (resolved.kind === "start_failed") {
      await deps.queue.fail(job.id, workerId, resolved.message);
      return;
    }

    let status: TerminalRunStatus;
    if (resolved.kind === "already_terminal") {
      status = resolved.status;
    } else {
      // Use a signal that is never aborted by lease loss — only runner stop
      // could wire controller.abort later; for now controller is unused for wait.
      status = await waitForRun(resolved.runId, controller.signal);
    }

    if (status === "completed") {
      log.info("granola call job: run completed {noteId} run={runId}", {
        noteId: job.noteId,
        tenantId: job.tenantId,
        runId: resolved.runId,
      });
      await deps.queue.complete(job.id, workerId);
      return;
    }
    await deps.queue.fail(
      job.id,
      workerId,
      `workflow run ${resolved.runId} ended with status ${status}`,
    );
  } catch (err) {
    if (controller.signal.aborted) {
      log.warn("granola call job: aborted {jobId}", { jobId: job.id });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await deps.queue.fail(job.id, workerId, message);
  } finally {
    clearInterval(heartbeat);
  }
}

export function createGranolaCallJobRunner(
  deps: GranolaCallJobRunnerDeps,
): GranolaCallJobRunner {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = deps.leaseMs ?? DEFAULT_GRANOLA_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const workerId = deps.workerId ?? defaultWorkerId();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runTimeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const waitForRun =
    deps.waitForRun ?? defaultWaitForRun(deps.db, pollIntervalMs, runTimeoutMs);
  const peekRunStatus =
    deps.peekRunStatus ?? defaultPeekRunStatus(deps.db);

  async function runOnce(): Promise<void> {
    // Claim one job at a time so idle batch members don't sit leased without a
    // heartbeat while an earlier job runs (reclaim race / double-process).
    for (let i = 0; i < batchSize; i++) {
      const jobs = await deps.queue.claimDue(1, workerId, leaseMs);
      if (jobs.length === 0) return;
      const controller = new AbortController();
      await processJob(
        deps,
        jobs[0]!,
        waitForRun,
        peekRunStatus,
        controller,
        workerId,
        leaseMs,
        heartbeatMs,
      );
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((err) => {
        log.error("granola call job runner: tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }, tickIntervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop, runOnce };
}
