// Persistence for the one schedules product table, kept apart from
// route and scheduler wiring so neither touches drizzle directly.
// `ScheduleStore` is the seam both `routes.ts` and `scheduler.ts`
// depend on; `createDrizzleScheduleStore` is its one production
// implementation, over `./schema.ts`. `createInMemoryScheduleStore` is
// the fake this package's own tests drive the route and scheduler
// surfaces through, with no database involved.
import { and, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schedules } from "./schema";
import type { ScheduleTrigger } from "./trigger";

export type ScheduleDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface ScheduleRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowDefinitionId: string;
  readonly trigger: ScheduleTrigger;
  readonly input: unknown;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateScheduleInput {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowDefinitionId: string;
  readonly trigger: ScheduleTrigger;
  readonly input: unknown;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly nextRunAt: Date;
}

export interface UpdateSchedulePatch {
  readonly enabled?: boolean;
  readonly trigger?: ScheduleTrigger;
  readonly input?: unknown;
  readonly nextRunAt?: Date;
}

export interface RecordRunInput {
  readonly id: string;
  readonly lastRunAt: Date;
  readonly nextRunAt: Date;
}

export interface ScheduleStore {
  create(input: CreateScheduleInput): Promise<ScheduleRow>;
  get(tenantId: string, id: string): Promise<ScheduleRow | undefined>;
  list(tenantId: string): Promise<ScheduleRow[]>;
  update(
    tenantId: string,
    id: string,
    patch: UpdateSchedulePatch,
  ): Promise<ScheduleRow | undefined>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Every enabled schedule whose `nextRunAt` is at or before `now`, across all tenants — the scheduler ticks the whole install, not one tenant at a time. */
  findDue(now: Date): Promise<ScheduleRow[]>;
  recordRun(input: RecordRunInput): Promise<void>;
}

function toRow(row: typeof schedules.$inferSelect): ScheduleRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workflowDefinitionId: row.workflowDefinitionId,
    trigger: row.trigger as ScheduleTrigger,
    input: row.input,
    enabled: row.enabled,
    createdBy: row.createdBy,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleScheduleStore<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(db: ScheduleDb<TSchema>): ScheduleStore {
  return {
    async create(input) {
      const now = new Date();
      const [row] = await db
        .insert(schedules)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          workflowDefinitionId: input.workflowDefinitionId,
          trigger: input.trigger,
          input: input.input,
          enabled: input.enabled,
          createdBy: input.createdBy,
          nextRunAt: input.nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("schedule insert returned no row");
      }
      return toRow(row);
    },

    async get(tenantId, id) {
      const [row] = await db
        .select()
        .from(schedules)
        .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
        .limit(1);
      return row === undefined ? undefined : toRow(row);
    },

    async list(tenantId) {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.tenantId, tenantId));
      return rows.map(toRow);
    },

    async update(tenantId, id, patch) {
      const [row] = await db
        .update(schedules)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
        .returning();
      return row === undefined ? undefined : toRow(row);
    },

    async delete(tenantId, id) {
      const deleted = await db
        .delete(schedules)
        .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
        .returning({ id: schedules.id });
      return deleted.length > 0;
    },

    async findDue(now) {
      const rows = await db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));
      return rows.map(toRow);
    },

    async recordRun(input) {
      await db
        .update(schedules)
        .set({
          lastRunAt: input.lastRunAt,
          nextRunAt: input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(schedules.id, input.id));
    },
  };
}

/**
 * An in-memory `ScheduleStore`, used only by this package's own tests
 * (cron due-computation, route validation) so they never need a real
 * database — production always runs `createDrizzleScheduleStore`.
 */
export function createInMemoryScheduleStore(): ScheduleStore {
  const rows = new Map<string, ScheduleRow>();

  return {
    async create(input) {
      const now = new Date();
      const row: ScheduleRow = {
        id: input.id,
        tenantId: input.tenantId,
        workflowDefinitionId: input.workflowDefinitionId,
        trigger: input.trigger,
        input: input.input,
        enabled: input.enabled,
        createdBy: input.createdBy,
        lastRunAt: null,
        nextRunAt: input.nextRunAt,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },

    async get(tenantId, id) {
      const row = rows.get(id);
      return row !== undefined && row.tenantId === tenantId ? row : undefined;
    },

    async list(tenantId) {
      return [...rows.values()].filter((row) => row.tenantId === tenantId);
    },

    async update(tenantId, id, patch) {
      const existing = rows.get(id);
      if (existing === undefined || existing.tenantId !== tenantId) {
        return undefined;
      }
      const updated: ScheduleRow = {
        ...existing,
        ...patch,
        updatedAt: new Date(),
      };
      rows.set(id, updated);
      return updated;
    },

    async delete(tenantId, id) {
      const existing = rows.get(id);
      if (existing === undefined || existing.tenantId !== tenantId) {
        return false;
      }
      rows.delete(id);
      return true;
    },

    async findDue(now) {
      return [...rows.values()].filter(
        (row) => row.enabled && row.nextRunAt.getTime() <= now.getTime(),
      );
    },

    async recordRun(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) return;
      rows.set(input.id, {
        ...existing,
        lastRunAt: input.lastRunAt,
        nextRunAt: input.nextRunAt,
        updatedAt: new Date(),
      });
    },
  };
}
