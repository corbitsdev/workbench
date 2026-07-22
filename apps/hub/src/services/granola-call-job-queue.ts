import { getLogger } from "@intx/log";
import type { GranolaCallJobRow, WorkUnitRow } from "../db/schema";
import type { HubDb } from "../db";
import type { WorkUnitQueue } from "./work-unit-queue";
import {
  createWorkUnitQueue,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from "./work-unit-queue";

const log = getLogger(["services", "granola-call-job-queue"]);

/** Work-unit kind for Granola note processing (single queue, many kinds). */
export const GRANOLA_CALL_KIND = "granola_call" as const;

export const MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
export const DEFAULT_GRANOLA_LEASE_MS = 120_000;

export function granolaCallIdempotencyKey(noteId: string): string {
  return `note:${noteId}`;
}

function noteIdFromUnit(unit: WorkUnitRow): string {
  const fromPayload = unit.payload["noteId"];
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    return fromPayload;
  }
  const key = unit.idempotencyKey;
  return key.startsWith("note:") ? key.slice("note:".length) : key;
}

/** Map work_unit status onto the historical GranolaCallJobRow status enum. */
function mapStatus(status: WorkUnitRow["status"]): GranolaCallJobRow["status"] {
  if (status === "leased") return "processing";
  if (status === "pending" || status === "done" || status === "dead") {
    return status;
  }
  return "pending";
}

export function workUnitToGranolaJob(unit: WorkUnitRow): GranolaCallJobRow {
  return {
    id: unit.id,
    tenantId: unit.tenantId,
    noteId: noteIdFromUnit(unit),
    status: mapStatus(unit.status),
    attempts: unit.attempts,
    nextAttemptAt: unit.nextAttemptAt,
    lastError: unit.lastError,
    leaseOwner: unit.leaseOwner,
    leaseUntil: unit.leaseUntil,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

export interface GranolaCallJobQueue {
  /** Enqueues one note for a tenant as a `granola_call` work unit. Idempotent
   * on `(tenant, kind, note:{noteId})`. */
  enqueue(tenantId: string, noteId: string): Promise<void>;
  /** Claims up to `limit` due `granola_call` work units (SKIP LOCKED + lease). */
  claimDue(
    limit: number,
    workerId?: string,
    leaseMs?: number,
  ): Promise<GranolaCallJobRow[]>;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseMs?: number,
  ): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<void>;
  /** Owner-fenced fail; attempt counter lives on work_unit (not caller-supplied). */
  fail(jobId: string, workerId: string, error: string): Promise<void>;
}

/**
 * Thin facade: Granola note jobs are work units with kind `granola_call`.
 * Callers keep the historical enqueue(tenant, noteId) shape; storage is `work_unit`.
 */
export function createGranolaCallJobQueue(
  db: HubDb,
  workUnits: WorkUnitQueue = createWorkUnitQueue(db),
): GranolaCallJobQueue {
  async function enqueue(tenantId: string, noteId: string): Promise<void> {
    const result = await workUnits.enqueue({
      tenantId,
      kind: GRANOLA_CALL_KIND,
      idempotencyKey: granolaCallIdempotencyKey(noteId),
      payload: { noteId },
      maxAttempts: MAX_ATTEMPTS,
    });
    if (result.created) {
      log.debug("granola call enqueued as work_unit {noteId}", {
        tenantId,
        noteId,
        unitId: result.id,
      });
    }
  }

  async function claimDue(
    limit: number,
    workerId: string = "granola-runner",
    leaseMs: number = DEFAULT_GRANOLA_LEASE_MS,
  ): Promise<GranolaCallJobRow[]> {
    const units = await workUnits.claimDue({
      workerId,
      limit,
      leaseMs,
      kinds: [GRANOLA_CALL_KIND],
    });
    return units.map(workUnitToGranolaJob);
  }

  async function heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number = DEFAULT_GRANOLA_LEASE_MS,
  ): Promise<boolean> {
    return workUnits.heartbeat(jobId, workerId, leaseMs);
  }

  async function complete(jobId: string, workerId: string): Promise<void> {
    await workUnits.complete(jobId, workerId);
  }

  async function fail(
    jobId: string,
    workerId: string,
    error: string,
  ): Promise<void> {
    await workUnits.fail(jobId, workerId, error);
  }

  return { enqueue, claimDue, complete, fail, heartbeat };
}

// Re-export for callers that previously imported lease default from here.
export { DEFAULT_LEASE_MS };
