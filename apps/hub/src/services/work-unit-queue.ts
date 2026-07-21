import { and, eq, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { workUnit, type WorkUnitRow } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["services", "work-unit-queue"]);

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_LEASE_MS = 60_000;

function backoffForAttempt(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows: Record<string, unknown>[] }).rows ?? [];
}

function mapWorkUnitRow(row: Record<string, unknown>): WorkUnitRow {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    kind: String(row["kind"]),
    idempotencyKey: String(row["idempotency_key"]),
    status: row["status"] as WorkUnitRow["status"],
    payload: (row["payload"] ?? {}) as Record<string, unknown>,
    attempts: Number(row["attempts"] ?? 0),
    maxAttempts: Number(row["max_attempts"] ?? DEFAULT_MAX_ATTEMPTS),
    nextAttemptAt: new Date(String(row["next_attempt_at"])),
    leaseOwner: row["lease_owner"] == null ? null : String(row["lease_owner"]),
    leaseUntil:
      row["lease_until"] == null ? null : new Date(String(row["lease_until"])),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    createdAt: new Date(String(row["created_at"])),
    updatedAt: new Date(String(row["updated_at"])),
  };
}

export type EnqueueWorkUnitInput = {
  tenantId: string;
  kind: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
};

export type WorkUnitHealth = {
  byStatus: Record<string, number>;
  byKindStatus: Array<{ kind: string; status: string; count: number }>;
  oldestPendingAgeMs: number | null;
  deadCount: number;
  agedLeasedCount: number;
};

export interface WorkUnitQueue {
  enqueue(input: EnqueueWorkUnitInput): Promise<{ id: string; created: boolean }>;
  claimDue(args: {
    workerId: string;
    limit: number;
    leaseMs?: number;
    kinds?: string[];
  }): Promise<WorkUnitRow[]>;
  heartbeat(unitId: string, workerId: string, leaseMs?: number): Promise<boolean>;
  complete(unitId: string, workerId: string): Promise<void>;
  fail(unitId: string, workerId: string, error: string): Promise<void>;
  retryDead(unitId: string): Promise<boolean>;
  discardDead(unitId: string): Promise<boolean>;
  listDead(args?: { limit?: number; tenantId?: string }): Promise<WorkUnitRow[]>;
  listAgedLeased(args?: {
    olderThanMs?: number;
    limit?: number;
  }): Promise<WorkUnitRow[]>;
  health(): Promise<WorkUnitHealth>;
}

export function createWorkUnitQueue(db: HubDb): WorkUnitQueue {
  async function enqueue(
    input: EnqueueWorkUnitInput,
  ): Promise<{ id: string; created: boolean }> {
    const inserted = await db
      .insert(workUnit)
      .values({
        tenantId: input.tenantId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? {},
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      })
      .onConflictDoNothing({
        target: [
          workUnit.tenantId,
          workUnit.kind,
          workUnit.idempotencyKey,
        ],
      })
      .returning({ id: workUnit.id });

    if (inserted[0]) {
      return { id: inserted[0].id, created: true };
    }

    const existing = await db
      .select({ id: workUnit.id })
      .from(workUnit)
      .where(
        and(
          eq(workUnit.tenantId, input.tenantId),
          eq(workUnit.kind, input.kind),
          eq(workUnit.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const id = existing[0]?.id;
    if (!id) {
      throw new Error(
        `work_unit enqueue conflict but row missing for ${input.kind}/${input.idempotencyKey}`,
      );
    }
    return { id, created: false };
  }

  async function claimDue(args: {
    workerId: string;
    limit: number;
    leaseMs?: number;
    kinds?: string[];
  }): Promise<WorkUnitRow[]> {
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const limit = Math.max(1, Math.min(args.limit, 100));
    const kinds = args.kinds;

    // Atomic claim: pick due rows under SKIP LOCKED, set lease in one statement.
    // Due = pending with next_attempt_at <= now, OR leased with lease_until <= now.
    const result = await db.execute(sql`
      UPDATE work_unit AS wu
      SET
        status = 'leased',
        lease_owner = ${args.workerId},
        lease_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
      FROM (
        SELECT id
        FROM work_unit
        WHERE (
          (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until <= now())
        )
        ${
          kinds && kinds.length > 0
            ? sql`AND kind IN (${sql.join(
                kinds.map((k) => sql`${k}`),
                sql`, `,
              )})`
            : sql``
        }
        ORDER BY next_attempt_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE wu.id = due.id
      RETURNING
        wu.id,
        wu.tenant_id,
        wu.kind,
        wu.idempotency_key,
        wu.status,
        wu.payload,
        wu.attempts,
        wu.max_attempts,
        wu.next_attempt_at,
        wu.lease_owner,
        wu.lease_until,
        wu.last_error,
        wu.created_at,
        wu.updated_at
    `);

    return rowsOf(result).map(mapWorkUnitRow);
  }

  async function heartbeat(
    unitId: string,
    workerId: string,
    leaseMs: number = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE work_unit
      SET
        lease_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
      WHERE id = ${unitId}::uuid
        AND status = 'leased'
        AND lease_owner = ${workerId}
      RETURNING id
    `);
    return rowsOf(result).length > 0;
  }

  async function complete(unitId: string, workerId: string): Promise<void> {
    const result = await db.execute(sql`
      UPDATE work_unit
      SET
        status = 'done',
        lease_owner = NULL,
        lease_until = NULL,
        last_error = NULL,
        updated_at = now()
      WHERE id = ${unitId}::uuid
        AND status = 'leased'
        AND lease_owner = ${workerId}
      RETURNING id
    `);
    if (rowsOf(result).length === 0) {
      log.warn("work_unit complete: not leased by worker {unitId}", {
        unitId,
        workerId,
      });
    }
  }

  async function fail(
    unitId: string,
    workerId: string,
    error: string,
  ): Promise<void> {
    const current = await db
      .select()
      .from(workUnit)
      .where(eq(workUnit.id, unitId))
      .limit(1);
    const row = current[0];
    if (!row) return;
    if (row.status !== "leased" || row.leaseOwner !== workerId) {
      log.warn("work_unit fail: not leased by worker {unitId}", {
        unitId,
        workerId,
      });
      return;
    }

    const attempts = row.attempts + 1;
    if (attempts >= row.maxAttempts) {
      log.error("work_unit: exhausted retries; marking dead {unitId}", {
        unitId,
        attempts,
        error: new Error(error),
      });
      await db
        .update(workUnit)
        .set({
          status: "dead",
          attempts,
          lastError: error,
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(eq(workUnit.id, unitId));
      return;
    }

    const backoffMs = backoffForAttempt(attempts);
    log.warn("work_unit: attempt failed; backing off {unitId}", {
      unitId,
      attempts,
      backoffMs,
      error: new Error(error),
    });
    await db
      .update(workUnit)
      .set({
        status: "pending",
        attempts,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(eq(workUnit.id, unitId));
  }

  async function retryDead(unitId: string): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE work_unit
      SET
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        next_attempt_at = now(),
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
      WHERE id = ${unitId}::uuid
        AND status = 'dead'
      RETURNING id
    `);
    return rowsOf(result).length > 0;
  }

  async function discardDead(unitId: string): Promise<boolean> {
    // Idempotent: dead stays dead; clears last_error noise only if we want —
    // contract is ack-dead without requeue. Mark via last_error prefix if still dead.
    const result = await db.execute(sql`
      UPDATE work_unit
      SET
        last_error = COALESCE(last_error, 'discarded by operator'),
        updated_at = now()
      WHERE id = ${unitId}::uuid
        AND status = 'dead'
      RETURNING id
    `);
    return rowsOf(result).length > 0;
  }

  async function listDead(args?: {
    limit?: number;
    tenantId?: string;
  }): Promise<WorkUnitRow[]> {
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 200));
    const result = await db.execute(sql`
      SELECT
        id, tenant_id, kind, idempotency_key, status, payload,
        attempts, max_attempts, next_attempt_at, lease_owner, lease_until,
        last_error, created_at, updated_at
      FROM work_unit
      WHERE status = 'dead'
      ${args?.tenantId ? sql`AND tenant_id = ${args.tenantId}` : sql``}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `);
    return rowsOf(result).map(mapWorkUnitRow);
  }

  async function listAgedLeased(args?: {
    olderThanMs?: number;
    limit?: number;
  }): Promise<WorkUnitRow[]> {
    const olderThanMs = args?.olderThanMs ?? 5 * 60_000;
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 200));
    const result = await db.execute(sql`
      SELECT
        id, tenant_id, kind, idempotency_key, status, payload,
        attempts, max_attempts, next_attempt_at, lease_owner, lease_until,
        last_error, created_at, updated_at
      FROM work_unit
      WHERE status = 'leased'
        AND lease_until IS NOT NULL
        AND lease_until <= now() - (${olderThanMs}::text || ' milliseconds')::interval
      ORDER BY lease_until ASC
      LIMIT ${limit}
    `);
    return rowsOf(result).map(mapWorkUnitRow);
  }

  async function health(): Promise<WorkUnitHealth> {
    const byStatusRows = rowsOf(
      await db.execute(sql`
        SELECT status, count(*)::int AS count
        FROM work_unit
        GROUP BY status
      `),
    );
    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byStatus[String(row["status"])] = Number(row["count"]);
    }

    const byKindStatus = rowsOf(
      await db.execute(sql`
        SELECT kind, status, count(*)::int AS count
        FROM work_unit
        GROUP BY kind, status
        ORDER BY kind, status
      `),
    ).map((row) => ({
      kind: String(row["kind"]),
      status: String(row["status"]),
      count: Number(row["count"]),
    }));

    const oldest = rowsOf(
      await db.execute(sql`
        SELECT EXTRACT(EPOCH FROM (now() - min(next_attempt_at))) * 1000 AS age_ms
        FROM work_unit
        WHERE status = 'pending'
      `),
    )[0];
    const ageRaw = oldest?.["age_ms"];
    const oldestPendingAgeMs =
      ageRaw == null || ageRaw === "" ? null : Math.max(0, Number(ageRaw));

    const agedLeased = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS count
        FROM work_unit
        WHERE status = 'leased'
          AND lease_until IS NOT NULL
          AND lease_until <= now() - interval '5 minutes'
      `),
    )[0];

    return {
      byStatus,
      byKindStatus,
      oldestPendingAgeMs:
        oldestPendingAgeMs !== null && Number.isFinite(oldestPendingAgeMs)
          ? oldestPendingAgeMs
          : null,
      deadCount: byStatus["dead"] ?? 0,
      agedLeasedCount: Number(agedLeased?.["count"] ?? 0),
    };
  }

  return {
    enqueue,
    claimDue,
    heartbeat,
    complete,
    fail,
    retryDead,
    discardDead,
    listDead,
    listAgedLeased,
    health,
  };
}
