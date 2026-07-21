import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  nextFireAt,
  type ScheduleScope,
  type ScheduledTrigger,
  type ScheduledTriggerFire,
} from "@workbench/shared";
import type { HubDb } from "../db";
import {
  scheduledTrigger,
  scheduledTriggerFire,
  workflowRunRecord,
  type ScheduledTriggerRow,
} from "../db/schema";
import type { ScheduledTriggerRow as SchedulerRow } from "../services/scheduler";
import { keysetBefore, takePage, type KeysetCursor } from "./keyset";

const DEFAULT_SCHEDULE_LIMIT = 50;

/** Recent fires returned on GET /me/schedules per schedule. */
export const SCHEDULE_FIRE_HISTORY_LIMIT = 5;
/** Rows retained per schedule after each new fire (trim on write). */
const SCHEDULE_FIRE_RETENTION = 30;

export type ScheduledTriggerPage = {
  items: ScheduledTriggerRow[];
  nextCursor?: string;
};

// Store for the scheduled_trigger table: the scheduler's read/mark path, the
// owner-scoped CRUD the /me/schedules routes call, and the boot-seeder upsert.
// Personal writes are scoped by owner principal; tenant-scope rows are unique
// per (tenant, kind) and visible to every member (CL-4108).

function toSchedulerRow(row: ScheduledTriggerRow): SchedulerRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workflowKind: row.workflowKind,
    hourUtc: row.hourUtc,
    lastFiredDayUtc: row.lastFiredDayUtc,
    ownerMemberPrincipalId: row.ownerMemberPrincipalId,
    triggerPayload: row.triggerPayload,
  };
}

function asScope(raw: string): ScheduleScope {
  return raw === "tenant" ? "tenant" : "personal";
}

export function toApiSchedule(
  row: ScheduledTriggerRow,
  now: Date = new Date(),
  recentFires: ScheduledTriggerFire[] = [],
): ScheduledTrigger {
  return {
    id: row.id,
    workflowKind: row.workflowKind,
    hourUtc: row.hourUtc,
    enabled: row.enabled,
    scope: asScope(row.scope),
    ownerMemberPrincipalId: row.ownerMemberPrincipalId,
    triggerPayload: row.triggerPayload,
    createdAt: row.createdAt.toISOString(),
    lastFiredDayUtc: row.lastFiredDayUtc,
    lastRunId: row.lastRunId ?? null,
    recentFires,
    nextFireAt: row.enabled
      ? nextFireAt(row.hourUtc, row.lastFiredDayUtc, now).toISOString()
      : null,
  };
}

export async function loadRecentFiresByScheduleId(
  db: HubDb,
  tenantId: string,
  scheduleIds: string[],
): Promise<Map<string, ScheduledTriggerFire[]>> {
  const out = new Map<string, ScheduledTriggerFire[]>();
  for (const id of scheduleIds) out.set(id, []);
  if (scheduleIds.length === 0) return out;

  const fires = await db
    .select({
      scheduleId: scheduledTriggerFire.scheduledTriggerId,
      runId: scheduledTriggerFire.runId,
      firedAt: scheduledTriggerFire.firedAt,
      status: workflowRunRecord.status,
    })
    .from(scheduledTriggerFire)
    .leftJoin(
      workflowRunRecord,
      and(
        eq(workflowRunRecord.id, scheduledTriggerFire.runId),
        eq(workflowRunRecord.tenantId, scheduledTriggerFire.tenantId),
      ),
    )
    .where(
      and(
        eq(scheduledTriggerFire.tenantId, tenantId),
        inArray(scheduledTriggerFire.scheduledTriggerId, scheduleIds),
      ),
    )
    .orderBy(desc(scheduledTriggerFire.firedAt));

  for (const row of fires) {
    const list = out.get(row.scheduleId);
    if (!list || list.length >= SCHEDULE_FIRE_HISTORY_LIMIT) continue;
    list.push({
      runId: row.runId,
      firedAt: row.firedAt.toISOString(),
      status: row.status ?? "unknown",
    });
  }
  return out;
}

export async function toApiSchedulesForOwner(
  db: HubDb,
  tenantId: string,
  rows: ScheduledTriggerRow[],
  now: Date = new Date(),
): Promise<ScheduledTrigger[]> {
  const fires = await loadRecentFiresByScheduleId(
    db,
    tenantId,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toApiSchedule(row, now, fires.get(row.id) ?? []),
  );
}

/** Called by the scheduler after `startWorkflowRun` succeeds (CL-3526). */
export async function recordScheduleRunStarted(
  db: HubDb,
  args: { scheduleId: string; tenantId: string; runId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(scheduledTrigger)
      .set({ lastRunId: args.runId })
      .where(
        and(
          eq(scheduledTrigger.id, args.scheduleId),
          eq(scheduledTrigger.tenantId, args.tenantId),
        ),
      );
    await tx.insert(scheduledTriggerFire).values({
      scheduledTriggerId: args.scheduleId,
      tenantId: args.tenantId,
      runId: args.runId,
    });
    await trimScheduleFireHistory(tx, args.scheduleId);
  });
}

async function trimScheduleFireHistory(
  db: HubDb,
  scheduleId: string,
): Promise<void> {
  const rows = await db
    .select({ id: scheduledTriggerFire.id })
    .from(scheduledTriggerFire)
    .where(eq(scheduledTriggerFire.scheduledTriggerId, scheduleId))
    .orderBy(desc(scheduledTriggerFire.firedAt));
  if (rows.length <= SCHEDULE_FIRE_RETENTION) return;
  const dropIds = rows.slice(SCHEDULE_FIRE_RETENTION).map((r) => r.id);
  await db
    .delete(scheduledTriggerFire)
    .where(inArray(scheduledTriggerFire.id, dropIds));
}

// Scheduler read path: every enabled schedule in the tenant. `shouldFire`
// filters by hour/day, so this returns all enabled rows regardless of time.
export async function listEnabledSchedules(
  db: HubDb,
  tenantId: string,
): Promise<SchedulerRow[]> {
  const rows = await db.query.scheduledTrigger.findMany({
    where: and(
      eq(scheduledTrigger.tenantId, tenantId),
      eq(scheduledTrigger.enabled, true),
    ),
  });
  return rows.map(toSchedulerRow);
}

/**
 * Scheduler read path across all tenants (CL-3342). Prefer this over
 * root-tenant-only enumeration so non-root schedule rows are evaluated.
 */
export async function listAllEnabledSchedules(
  db: HubDb,
): Promise<SchedulerRow[]> {
  const rows = await db.query.scheduledTrigger.findMany({
    where: eq(scheduledTrigger.enabled, true),
  });
  return rows.map(toSchedulerRow);
}

// Scheduler mark path: record the UTC day a schedule last fired on. Called
// before the run-start await so a slow start cannot double-fire.
export async function markScheduleFired(
  db: HubDb,
  id: string,
  dayUtc: number,
): Promise<void> {
  await db
    .update(scheduledTrigger)
    .set({ lastFiredDayUtc: dayUtc })
    .where(eq(scheduledTrigger.id, id));
}

/**
 * Schedules visible to a member: their personal rows plus every tenant-scoped
 * (Everyone) schedule in the same tenant (CL-4108).
 */
export async function listOwnerSchedules(
  db: HubDb,
  tenantId: string,
  ownerPrincipalId: string,
  opts?: { limit?: number; cursor?: KeysetCursor },
): Promise<ScheduledTriggerPage> {
  const conditions = [
    eq(scheduledTrigger.tenantId, tenantId),
    or(
      and(
        eq(scheduledTrigger.scope, "personal"),
        eq(scheduledTrigger.ownerMemberPrincipalId, ownerPrincipalId),
      ),
      eq(scheduledTrigger.scope, "tenant"),
    )!,
  ];
  if (opts?.cursor) {
    const before = keysetBefore(
      scheduledTrigger.createdAt,
      scheduledTrigger.id,
      opts.cursor,
    );
    if (before) conditions.push(before);
  }
  const limit = opts?.limit ?? DEFAULT_SCHEDULE_LIMIT;
  const rows = await db.query.scheduledTrigger.findMany({
    where: and(...conditions),
    orderBy: [desc(scheduledTrigger.createdAt), desc(scheduledTrigger.id)],
    limit: limit + 1,
  });
  return takePage(rows, limit);
}

export async function createOwnerSchedule(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    kind: string;
    hourUtc: number;
    payload: Record<string, unknown>;
    scope?: ScheduleScope;
  },
): Promise<ScheduledTriggerRow> {
  const scope = args.scope ?? "personal";
  const [inserted] = await db
    .insert(scheduledTrigger)
    .values({
      tenantId: args.tenantId,
      ownerMemberPrincipalId: args.ownerPrincipalId,
      workflowKind: args.kind,
      hourUtc: args.hourUtc,
      triggerPayload: args.payload,
      scope,
    })
    .returning();
  if (!inserted) {
    throw new Error("scheduled_trigger insert returned no row");
  }
  return inserted;
}

// Owner-scoped update. Returns null when no row matches the (tenant, owner, id)
// triple — a missing id OR another member's id both surface as "not found",
// so a member can never mutate another's schedule (including tenant schedules
// they did not create).
export async function updateOwnerSchedule(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    id: string;
    enabled?: boolean;
    hourUtc?: number;
  },
): Promise<ScheduledTriggerRow | null> {
  const patch: { enabled?: boolean; hourUtc?: number } = {};
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.hourUtc !== undefined) patch.hourUtc = args.hourUtc;

  const [updated] = await db
    .update(scheduledTrigger)
    .set(patch)
    .where(
      and(
        eq(scheduledTrigger.id, args.id),
        eq(scheduledTrigger.tenantId, args.tenantId),
        eq(scheduledTrigger.ownerMemberPrincipalId, args.ownerPrincipalId),
      ),
    )
    .returning();
  return updated ?? null;
}

// Owner-scoped delete. Returns false when no row matched the (tenant, owner, id)
// triple, so deleting another member's schedule is a no-op 404.
export async function deleteOwnerSchedule(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; id: string },
): Promise<boolean> {
  const deleted = await db
    .delete(scheduledTrigger)
    .where(
      and(
        eq(scheduledTrigger.id, args.id),
        eq(scheduledTrigger.tenantId, args.tenantId),
        eq(scheduledTrigger.ownerMemberPrincipalId, args.ownerPrincipalId),
      ),
    )
    .returning({ id: scheduledTrigger.id });
  return deleted.length > 0;
}

// Idempotent boot seed: ensure a *personal* schedule of `kind` exists for the
// owner. Does NOT overwrite an existing row, so a member's later customization
// of hour or payload survives reboots. Uses select-then-insert so partial unique
// indexes (CL-4108) do not need ON CONFLICT target gymnastics.
export async function ensureOwnerSchedule(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    kind: string;
    hourUtc: number;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await db.query.scheduledTrigger.findFirst({
    where: and(
      eq(scheduledTrigger.tenantId, args.tenantId),
      eq(scheduledTrigger.ownerMemberPrincipalId, args.ownerPrincipalId),
      eq(scheduledTrigger.workflowKind, args.kind),
      eq(scheduledTrigger.scope, "personal"),
    ),
    columns: { id: true },
  });
  if (existing) return;
  try {
    await db.insert(scheduledTrigger).values({
      tenantId: args.tenantId,
      ownerMemberPrincipalId: args.ownerPrincipalId,
      workflowKind: args.kind,
      hourUtc: args.hourUtc,
      triggerPayload: args.payload,
      scope: "personal",
    });
  } catch (err) {
    // Concurrent boot seeds can race the unique index; treat as already present.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Scope of the schedule that produced this run, if any (CL-4114 fan-out).
 * Returns null when the run was not started by the scheduler (or fire history
 * was trimmed).
 */
export async function scheduleScopeForRun(
  db: HubDb,
  runId: string,
): Promise<ScheduleScope | null> {
  const rows = await db
    .select({ scope: scheduledTrigger.scope })
    .from(scheduledTriggerFire)
    .innerJoin(
      scheduledTrigger,
      eq(scheduledTrigger.id, scheduledTriggerFire.scheduledTriggerId),
    )
    .where(eq(scheduledTriggerFire.runId, runId))
    .limit(1);
  const scope = rows[0]?.scope;
  if (scope === "tenant" || scope === "personal") return scope;
  return null;
}
