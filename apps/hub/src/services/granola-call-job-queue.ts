import { sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { type GranolaCallJobRow } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["services", "granola-call-job-queue"]);

// Backoff schedule for a transient LLM/API failure: start at 1 minute, double
// per consecutive failure, cap at 30 minutes. After MAX_ATTEMPTS the job is
// marked `dead` rather than retried forever — a permanently-broken note (bad
// transcript, persistent upstream 4xx) must not spin the runner indefinitely.
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 8;
export const DEFAULT_GRANOLA_LEASE_MS = 120_000;

function backoffForAttempt(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows: Record<string, unknown>[] }).rows ?? [];
}

function mapJobRow(row: Record<string, unknown>): GranolaCallJobRow {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    noteId: String(row["note_id"]),
    status: row["status"] as GranolaCallJobRow["status"],
    attempts: Number(row["attempts"] ?? 0),
    nextAttemptAt: new Date(String(row["next_attempt_at"])),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    leaseOwner: row["lease_owner"] == null ? null : String(row["lease_owner"]),
    leaseUntil:
      row["lease_until"] == null ? null : new Date(String(row["lease_until"])),
    createdAt: new Date(String(row["created_at"])),
    updatedAt: new Date(String(row["updated_at"])),
  };
}

export interface GranolaCallJobQueue {
  /** Enqueues one note for a tenant. Idempotent: a note already queued (any
   * status) is left untouched — this is enqueue-dedupe, not a resubmit. */
  enqueue(tenantId: string, noteId: string): Promise<void>;
  /** Claims up to `limit` due jobs with FOR UPDATE SKIP LOCKED + visibility
   * lease. Expired processing leases reclaim without a sweeper. */
  claimDue(
    limit: number,
    workerId?: string,
    leaseMs?: number,
  ): Promise<GranolaCallJobRow[]>;
  /** Extends the lease while the same worker still holds it. */
  heartbeat(
    jobId: string,
    workerId: string,
    leaseMs?: number,
  ): Promise<boolean>;
  /** Marks a claimed job done. */
  complete(jobId: string): Promise<void>;
  /** Records a failed attempt: increments `attempts`, sets `next_attempt_at`
   * to the backoff window, or marks `dead` past `MAX_ATTEMPTS`. */
  fail(jobId: string, attempts: number, error: string): Promise<void>;
}

export function createGranolaCallJobQueue(db: HubDb): GranolaCallJobQueue {
  async function enqueue(tenantId: string, noteId: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO granola_call_job (tenant_id, note_id)
      VALUES (${tenantId}, ${noteId})
      ON CONFLICT (tenant_id, note_id) DO NOTHING
    `);
  }

  async function claimDue(
    limit: number,
    workerId: string = "granola-runner",
    leaseMs: number = DEFAULT_GRANOLA_LEASE_MS,
  ): Promise<GranolaCallJobRow[]> {
    const capped = Math.max(1, Math.min(limit, 100));
    const result = await db.execute(sql`
      UPDATE granola_call_job AS j
      SET
        status = 'processing',
        lease_owner = ${workerId},
        lease_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
      FROM (
        SELECT id
        FROM granola_call_job
        WHERE (
          (status = 'pending' AND next_attempt_at <= now())
          OR (
            status = 'processing'
            AND lease_until IS NOT NULL
            AND lease_until <= now()
          )
        )
        ORDER BY next_attempt_at ASC
        LIMIT ${capped}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE j.id = due.id
      RETURNING
        j.id,
        j.tenant_id,
        j.note_id,
        j.status,
        j.attempts,
        j.next_attempt_at,
        j.last_error,
        j.lease_owner,
        j.lease_until,
        j.created_at,
        j.updated_at
    `);
    return rowsOf(result).map(mapJobRow);
  }

  async function heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number = DEFAULT_GRANOLA_LEASE_MS,
  ): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE granola_call_job
      SET
        lease_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
      WHERE id = ${jobId}::uuid
        AND status = 'processing'
        AND lease_owner = ${workerId}
      RETURNING id
    `);
    return rowsOf(result).length > 0;
  }

  async function complete(jobId: string): Promise<void> {
    await db.execute(sql`
      UPDATE granola_call_job
      SET
        status = 'done',
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
      WHERE id = ${jobId}::uuid
    `);
  }

  async function fail(
    jobId: string,
    attempts: number,
    error: string,
  ): Promise<void> {
    if (attempts >= MAX_ATTEMPTS) {
      log.error("granola call job: exhausted retries; marking dead {jobId}", {
        jobId,
        attempts,
        error: new Error(error),
      });
      await db.execute(sql`
        UPDATE granola_call_job
        SET
          status = 'dead',
          attempts = ${attempts},
          last_error = ${error},
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = now()
        WHERE id = ${jobId}::uuid
      `);
      return;
    }

    const backoffMs = backoffForAttempt(attempts);
    log.warn("granola call job: attempt failed; backing off {jobId}", {
      jobId,
      attempts,
      backoffMs,
      error: new Error(error),
    });
    await db.execute(sql`
      UPDATE granola_call_job
      SET
        status = 'pending',
        attempts = ${attempts},
        last_error = ${error},
        next_attempt_at = now() + (${backoffMs}::text || ' milliseconds')::interval,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
      WHERE id = ${jobId}::uuid
    `);
  }

  return { enqueue, claimDue, complete, fail, heartbeat };
}
