import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import type { WorkUnitQueue } from "./work-unit-queue";
import { DEFAULT_LEASE_MS } from "./work-unit-queue";
import {
  AGENT_TASK_TURN_KIND,
  createDefaultAgentTaskTurnRunner,
  enqueueDueAgentTaskTurns,
  runAgentTaskTurnUnit,
  type AgentTaskTurnRunner,
} from "./agent-task-auto-pickup";
import {
  KNOWLEDGE_CAPTURE_KIND,
  runKnowledgeCaptureUnit,
  type KnowledgeCaptureRunner,
} from "./knowledge-capture-outbox";

const log = getLogger(["services", "work-unit-worker"]);

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_BATCH = 5;
const DEFAULT_HEARTBEAT_MS = 20_000;

function defaultWorkerId(): string {
  return `work-unit-worker:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

export type WorkUnitWorkerDeps = {
  db: HubDb;
  queue: WorkUnitQueue;
  knowledgeCaptureRunner?: KnowledgeCaptureRunner;
  agentTaskTurnRunner?: AgentTaskTurnRunner;
  tickIntervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  workerId?: string;
  /** When true, each tick also scans product tasks for auto-pickup enqueue. */
  scanAgentAutoPickup?: boolean;
};

export type WorkUnitWorker = {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
};

export function createWorkUnitWorker(
  deps: WorkUnitWorkerDeps,
): WorkUnitWorker {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const workerId = deps.workerId ?? defaultWorkerId();
  const agentRunner =
    deps.agentTaskTurnRunner ?? createDefaultAgentTaskTurnRunner(deps.db);
  const knowledgeRunner =
    deps.knowledgeCaptureRunner ??
    (async () => {
      // No-op until a real capture pipeline is injected. Completing without
      // work would hide missing wiring — fail soft with a clear error so the
      // unit retries/dead-letters visibly.
      throw new Error(
        "knowledge_capture runner not configured (inject knowledgeCaptureRunner)",
      );
    });

  async function processUnit(
    unit: Awaited<ReturnType<WorkUnitQueue["claimDue"]>>[number],
  ): Promise<void> {
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      deps.queue
        .heartbeat(unit.id, workerId, leaseMs)
        .then((ok) => {
          if (!ok && !controller.signal.aborted) {
            log.warn("work-unit worker: lost lease; aborting {unitId}", {
              unitId: unit.id,
              workerId,
            });
            controller.abort();
          }
        })
        .catch((err) => {
          log.warn("work-unit worker: heartbeat failed {unitId}", {
            unitId: unit.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, heartbeatMs);

    try {
      if (unit.kind === KNOWLEDGE_CAPTURE_KIND) {
        await runKnowledgeCaptureUnit({
          tenantId: unit.tenantId,
          payload: unit.payload,
          runner: knowledgeRunner,
          signal: controller.signal,
        });
      } else if (unit.kind === AGENT_TASK_TURN_KIND) {
        await runAgentTaskTurnUnit({
          tenantId: unit.tenantId,
          payload: unit.payload,
          runner: agentRunner,
          signal: controller.signal,
        });
      } else {
        throw new Error(`work-unit worker: unsupported kind ${unit.kind}`);
      }
      await deps.queue.complete(unit.id, workerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.queue.fail(unit.id, workerId, message);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function runOnce(): Promise<void> {
    if (deps.scanAgentAutoPickup !== false) {
      try {
        await enqueueDueAgentTaskTurns(deps.db, deps.queue);
      } catch (err) {
        log.error("work-unit worker: auto-pickup scan failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // Claim one unit at a time so a long-running unit doesn't leave the rest
    // of a batch leased-without-heartbeat (reclaim race / double-process).
    for (let i = 0; i < batchSize; i++) {
      const units = await deps.queue.claimDue({
        workerId,
        limit: 1,
        leaseMs,
        kinds: [KNOWLEDGE_CAPTURE_KIND, AGENT_TASK_TURN_KIND],
      });
      if (units.length === 0) break;
      await processUnit(units[0]!);
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((err) => {
        log.error("work-unit worker: tick failed", {
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
