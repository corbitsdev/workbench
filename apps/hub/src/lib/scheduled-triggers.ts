import { and, eq } from "drizzle-orm";
import type { ScheduledTrigger } from "@workbench/shared";
import type { HubDb } from "../db";
import { scheduledTrigger, type ScheduledTriggerRow } from "../db/schema";
import type { ScheduledTriggerRow as SchedulerRow } from "../services/scheduler";

// Store for the scheduled_trigger table: the scheduler's read/mark path, the
// owner-scoped CRUD the /me/schedules routes call, and the boot-seeder upsert.
// Every write is scoped by owner principal so one member can never address
// another's row.

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

export function toApiSchedule(row: ScheduledTriggerRow): ScheduledTrigger {
  return {
    id: row.id,
    workflowKind: row.workflowKind,
    hourUtc: row.hourUtc,
    enabled: row.enabled,
    triggerPayload: row.triggerPayload,
    createdAt: row.createdAt.toISOString(),
  };
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

export async function listOwnerSchedules(
  db: HubDb,
  tenantId: string,
  ownerPrincipalId: string,
): Promise<ScheduledTriggerRow[]> {
  return db.query.scheduledTrigger.findMany({
    where: and(
      eq(scheduledTrigger.tenantId, tenantId),
      eq(scheduledTrigger.ownerMemberPrincipalId, ownerPrincipalId),
    ),
  });
}

export async function createOwnerSchedule(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    kind: string;
    hourUtc: number;
    payload: Record<string, unknown>;
  },
): Promise<ScheduledTriggerRow> {
  const [inserted] = await db
    .insert(scheduledTrigger)
    .values({
      tenantId: args.tenantId,
      ownerMemberPrincipalId: args.ownerPrincipalId,
      workflowKind: args.kind,
      hourUtc: args.hourUtc,
      triggerPayload: args.payload,
    })
    .returning();
  if (!inserted) {
    throw new Error("scheduled_trigger insert returned no row");
  }
  return inserted;
}

// Owner-scoped update. Returns null when no row matches the (tenant, owner, id)
// triple — a missing id OR another member's id both surface as "not found",
// so a member can never mutate another's schedule.
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

// Idempotent boot seed: ensure a schedule of `kind` exists for the owner. Does
// NOT overwrite an existing row (unique on tenant+owner+kind), so a member's
// later customization of hour or payload survives reboots.
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
  await db
    .insert(scheduledTrigger)
    .values({
      tenantId: args.tenantId,
      ownerMemberPrincipalId: args.ownerPrincipalId,
      workflowKind: args.kind,
      hourUtc: args.hourUtc,
      triggerPayload: args.payload,
    })
    .onConflictDoNothing({
      target: [
        scheduledTrigger.tenantId,
        scheduledTrigger.ownerMemberPrincipalId,
        scheduledTrigger.workflowKind,
      ],
    });
}
