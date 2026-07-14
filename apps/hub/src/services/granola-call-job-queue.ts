import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { granolaCallJob, type GranolaCallJobRow } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["services", "granola-call-job-queue"]);

// Backoff schedule for a transient LLM/API failure: start at 1 minute, double
// per consecutive failure, cap at 30 minutes. After MAX_ATTEMPTS the job is
// marked `dead` rather than retried forever — a permanently-broken note (bad
// transcript, persistent upstream 4xx) must not spin the runner indefinitely.
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 8;

function backoffForAttempt(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

export interface GranolaCallJobQueue {
  /** Enqueues one note for a tenant. Idempotent: a note already queued (any
   * status) is left untouched — this is enqueue-dedupe, not a resubmit. */
  enqueue(tenantId: string, noteId: string): Promise<void>;
  /** Claims up to `limit` due jobs (`pending`/backed-off, `next_attempt_at` <=
   * now) and marks them `processing`, oldest first. A claimed row will not be
   * claimed again by a concurrent runner tick until it is completed/failed. */
  claimDue(limit: number): Promise<GranolaCallJobRow[]>;
  /** Marks a claimed job done. */
  complete(jobId: string): Promise<void>;
  /** Records a failed attempt: increments `attempts`, sets `next_attempt_at`
   * to the backoff window, or marks `dead` past `MAX_ATTEMPTS`. */
  fail(jobId: string, attempts: number, error: string): Promise<void>;
}

export function createGranolaCallJobQueue(db: HubDb): GranolaCallJobQueue {
  async function enqueue(tenantId: string, noteId: string): Promise<void> {
    await db
      .insert(granolaCallJob)
      .values({ tenantId, noteId })
      .onConflictDoNothing({
        target: [granolaCallJob.tenantId, granolaCallJob.noteId],
      });
  }

  async function claimDue(limit: number): Promise<GranolaCallJobRow[]> {
    const due = await db
      .select({ id: granolaCallJob.id })
      .from(granolaCallJob)
      .where(
        and(
          eq(granolaCallJob.status, "pending"),
          lte(granolaCallJob.nextAttemptAt, sql`now()`),
        ),
      )
      .orderBy(asc(granolaCallJob.nextAttemptAt))
      .limit(limit);

    if (due.length === 0) return [];

    const ids = due.map((row) => row.id);
    return db
      .update(granolaCallJob)
      .set({ status: "processing" })
      .where(
        and(
          eq(granolaCallJob.status, "pending"),
          inArray(granolaCallJob.id, ids),
        ),
      )
      .returning();
  }

  async function complete(jobId: string): Promise<void> {
    await db
      .update(granolaCallJob)
      .set({ status: "done" })
      .where(eq(granolaCallJob.id, jobId));
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
      await db
        .update(granolaCallJob)
        .set({ status: "dead", attempts, lastError: error })
        .where(eq(granolaCallJob.id, jobId));
      return;
    }

    const backoffMs = backoffForAttempt(attempts);
    log.warn("granola call job: attempt failed; backing off {jobId}", {
      jobId,
      attempts,
      backoffMs,
      error: new Error(error),
    });
    await db
      .update(granolaCallJob)
      .set({
        status: "pending",
        attempts,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + backoffMs),
      })
      .where(eq(granolaCallJob.id, jobId));
  }

  return { enqueue, claimDue, complete, fail };
}
