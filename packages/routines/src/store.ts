// Persistence for the two routines tables, kept apart from route
// wiring the same way `@corbits/chat`'s `store.ts` separates
// persistence from `routes.ts`. `RoutineStore` is the seam the route
// layer depends on; `createDrizzleRoutineStore` is its one production
// implementation, over the tables in `./schema.ts`.
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { hexEncode } from "@intx/types";

import { routine, routineRun } from "./schema";
import { computeNextFireAt, type RoutineTriggerT } from "./trigger";

export type RoutineDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export type RoutineScope = "personal" | "bench";

export interface RoutineRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: RoutineScope;
  readonly input: Record<string, unknown>;
  readonly enabled: boolean;
  readonly deliveryChannelId: string | null;
  readonly createdBy: string;
  readonly nextFireAt: Date | null;
  readonly lastFireAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateRoutineInput {
  readonly tenantId: string;
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: RoutineScope;
  readonly input: Record<string, unknown>;
  readonly deliveryChannelId?: string | null;
  readonly createdBy: string;
}

export interface UpdateRoutineInput {
  readonly name?: string;
  readonly trigger?: RoutineTriggerT;
  readonly input?: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly deliveryChannelId?: string | null;
}

export interface RoutineRunRow {
  readonly tenantId: string;
  readonly routineId: string;
  readonly runId: string;
  readonly triggeredBy: string;
  readonly createdAt: Date;
}

export interface RoutineStore {
  createRoutine(input: CreateRoutineInput): Promise<RoutineRow>;
  /** `undefined` for an unknown OR a soft-deleted routine. */
  getRoutine(
    tenantId: string,
    routineId: string,
  ): Promise<RoutineRow | undefined>;
  /**
   * Same lookup as `getRoutine`, but a soft-deleted routine is still
   * returned — the one caller that needs this is run-history lookup
   * (`GET /routines/:id/runs`), which must keep resolving a deleted
   * routine's id so its history stays reachable, while every other
   * caller (get/patch/run-now/list) treats "deleted" as "gone."
   */
  getRoutineIncludingDeleted(
    tenantId: string,
    routineId: string,
  ): Promise<RoutineRow | undefined>;
  /** Excludes soft-deleted routines. */
  listRoutines(tenantId: string): Promise<RoutineRow[]>;
  updateRoutine(
    tenantId: string,
    routineId: string,
    patch: UpdateRoutineInput,
  ): Promise<RoutineRow>;
  /** Soft-delete: the row (and its run history) survive; see schema.ts. */
  deleteRoutine(tenantId: string, routineId: string): Promise<boolean>;
  /**
   * Records that `runId` was launched under `routineId` — called
   * inside the same launch call every routine fire goes through
   * (scheduled or "run now" alike), never a second bookkeeping path.
   */
  recordRoutineRun(input: {
    tenantId: string;
    routineId: string;
    runId: string;
    triggeredBy: string;
  }): Promise<RoutineRunRow>;
  listRunsForRoutine(
    tenantId: string,
    routineId: string,
  ): Promise<RoutineRunRow[]>;
  /**
   * Every enabled, timer-triggered routine whose `nextFireAt` is at or
   * before `now` — across every tenant, the one cross-tenant read a
   * scheduler needs and no per-request route ever does. "At or before,"
   * not "equal to": a fire that was due while nothing was polling is
   * still due, not skipped.
   */
  listDueRoutines(now: Date): Promise<RoutineRow[]>;
  /**
   * Atomically claims `routineId`'s current due fire: advances
   * `nextFireAt` to the trigger's following occurrence and stamps
   * `lastFireAt`, but only if `nextFireAt` is still `<= now` at the
   * moment of the write. A second caller racing the same fire loses —
   * the first claim already moved `nextFireAt` into the future, so the
   * second claim's conditional write matches no row and returns
   * `undefined`. This is the seam that makes a scheduled fire
   * exactly-once under concurrent pollers: the claim happens before
   * anything launches, never after.
   */
  claimRoutineFire(
    routineId: string,
    now: Date,
  ): Promise<RoutineRow | undefined>;
  /**
   * Undoes a claim whose launch failed: restores `nextFireAt` to
   * `revertNextFireAt` (the moment the claim was made for) so the next
   * scheduler poll sees the fire as due again instead of silently
   * skipping it until the trigger's following occurrence. Called only
   * after `claimRoutineFire` returned a row and the subsequent launch
   * threw — a claim that was never granted needs no compensation.
   */
  compensateFailedFire(
    routineId: string,
    revertNextFireAt: Date,
  ): Promise<void>;
}

// `@intx/hub-common`'s `generateId` is closed over the platform's own
// ID kinds (tenant, principal, session, ...), which a Routine is not —
// it is a product entity this package owns, not a platform-native
// resource. This mints ids with the exact same primitive
// (`crypto.getRandomValues` + hex encoding) generateId uses, under its
// own `rtn_` prefix, rather than smuggling a new kind into the
// platform's enumeration.
function generateRoutineId(): string {
  const bytes = hexEncode(crypto.getRandomValues(new Uint8Array(16)));
  return `rtn_${bytes}`;
}

export function createDrizzleRoutineStore<
  TSchema extends Record<string, unknown>,
>(db: RoutineDb<TSchema>): RoutineStore {
  return {
    async createRoutine(input) {
      const now = new Date();
      const [row] = await db
        .insert(routine)
        .values({
          id: generateRoutineId(),
          tenantId: input.tenantId,
          name: input.name,
          definitionId: input.definitionId,
          trigger: input.trigger,
          scope: input.scope,
          input: input.input,
          enabled: true,
          deliveryChannelId: input.deliveryChannelId ?? null,
          createdBy: input.createdBy,
          nextFireAt: computeNextFireAt(input.trigger, now),
          lastFireAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("createRoutine: insert returned no row");
      }
      return row as RoutineRow;
    },

    async getRoutine(tenantId, routineId) {
      const [row] = await db
        .select()
        .from(routine)
        .where(
          and(
            eq(routine.tenantId, tenantId),
            eq(routine.id, routineId),
            isNull(routine.deletedAt),
          ),
        )
        .limit(1);
      return row as RoutineRow | undefined;
    },

    async getRoutineIncludingDeleted(tenantId, routineId) {
      const [row] = await db
        .select()
        .from(routine)
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .limit(1);
      return row as RoutineRow | undefined;
    },

    async listRoutines(tenantId) {
      const rows = await db
        .select()
        .from(routine)
        .where(and(eq(routine.tenantId, tenantId), isNull(routine.deletedAt)));
      return rows as RoutineRow[];
    },

    async updateRoutine(tenantId, routineId, patch) {
      const [existing] = await db
        .select()
        .from(routine)
        .where(
          and(
            eq(routine.tenantId, tenantId),
            eq(routine.id, routineId),
            isNull(routine.deletedAt),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      const now = new Date();
      const recomputeNextFire =
        patch.trigger !== undefined || patch.enabled !== undefined;
      const mergedTrigger =
        patch.trigger !== undefined
          ? patch.trigger
          : (existing as RoutineRow).trigger;
      const mergedEnabled =
        patch.enabled !== undefined
          ? patch.enabled
          : (existing as RoutineRow).enabled;
      const [row] = await db
        .update(routine)
        .set({
          ...patch,
          ...(recomputeNextFire
            ? {
                nextFireAt: mergedEnabled
                  ? computeNextFireAt(mergedTrigger, now)
                  : null,
              }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .returning();
      if (row === undefined) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      return row as RoutineRow;
    },

    async deleteRoutine(tenantId, routineId) {
      const deleted = await db
        .update(routine)
        .set({ deletedAt: new Date(), nextFireAt: null })
        .where(
          and(
            eq(routine.tenantId, tenantId),
            eq(routine.id, routineId),
            isNull(routine.deletedAt),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    async listDueRoutines(now) {
      const rows = await db
        .select()
        .from(routine)
        .where(
          and(
            eq(routine.enabled, true),
            isNull(routine.deletedAt),
            lte(routine.nextFireAt, now),
          ),
        );
      return rows as RoutineRow[];
    },

    async claimRoutineFire(routineId, now) {
      // A transaction with `FOR UPDATE` locks the row for the read
      // that decides `nextFireAt`'s new value, so a concurrent `PATCH`
      // of this routine's trigger can't sneak in between "read the
      // trigger" and "write the value computed from it" — it blocks
      // until this transaction commits, then (having already recomputed
      // its own `nextFireAt` off the new trigger in `updateRoutine`)
      // is never clobbered by a value computed from the stale one.
      return await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(routine)
          .where(eq(routine.id, routineId))
          .for("update")
          .limit(1);
        if (current === undefined || current.trigger === null) {
          return undefined;
        }
        const nextFireAt = computeNextFireAt(
          current.trigger as RoutineTriggerT,
          now,
        );
        const [claimed] = await tx
          .update(routine)
          .set({ nextFireAt, lastFireAt: now })
          .where(
            and(
              eq(routine.id, routineId),
              eq(routine.enabled, true),
              lte(routine.nextFireAt, now),
            ),
          )
          .returning();
        return claimed as RoutineRow | undefined;
      });
    },

    async compensateFailedFire(routineId, revertNextFireAt) {
      await db
        .update(routine)
        .set({ nextFireAt: revertNextFireAt })
        .where(eq(routine.id, routineId));
    },

    async recordRoutineRun(input) {
      const [row] = await db.insert(routineRun).values(input).returning();
      if (row === undefined) {
        throw new Error("recordRoutineRun: insert returned no row");
      }
      return row as RoutineRunRow;
    },

    async listRunsForRoutine(tenantId, routineId) {
      const rows = await db
        .select()
        .from(routineRun)
        .where(
          and(
            eq(routineRun.tenantId, tenantId),
            eq(routineRun.routineId, routineId),
          ),
        )
        .orderBy(desc(routineRun.createdAt));
      return rows as RoutineRunRow[];
    },
  };
}

/**
 * An in-memory `RoutineStore`, for tests and any host that wants
 * routine routes without a database. Not a supported deployment
 * target.
 */
export function createInMemoryRoutineStore(): RoutineStore {
  const routinesById = new Map<string, RoutineRow>();
  const runs: RoutineRunRow[] = [];

  return {
    async createRoutine(input) {
      const now = new Date();
      const row: RoutineRow = {
        id: generateRoutineId(),
        tenantId: input.tenantId,
        name: input.name,
        definitionId: input.definitionId,
        trigger: input.trigger,
        scope: input.scope,
        input: input.input,
        enabled: true,
        deliveryChannelId: input.deliveryChannelId ?? null,
        createdBy: input.createdBy,
        nextFireAt: computeNextFireAt(input.trigger, now),
        lastFireAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      routinesById.set(row.id, row);
      return row;
    },

    async getRoutine(tenantId, routineId) {
      const row = routinesById.get(routineId);
      if (row === undefined || row.tenantId !== tenantId) return undefined;
      return row.deletedAt === null ? row : undefined;
    },

    async getRoutineIncludingDeleted(tenantId, routineId) {
      const row = routinesById.get(routineId);
      return row?.tenantId === tenantId ? row : undefined;
    },

    async listRoutines(tenantId) {
      return [...routinesById.values()].filter(
        (row) => row.tenantId === tenantId && row.deletedAt === null,
      );
    },

    async updateRoutine(tenantId, routineId, patch) {
      const existing = routinesById.get(routineId);
      if (
        existing === undefined ||
        existing.tenantId !== tenantId ||
        existing.deletedAt !== null
      ) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      const now = new Date();
      const recomputeNextFire =
        patch.trigger !== undefined || patch.enabled !== undefined;
      const mergedTrigger =
        patch.trigger !== undefined ? patch.trigger : existing.trigger;
      const mergedEnabled =
        patch.enabled !== undefined ? patch.enabled : existing.enabled;
      const row: RoutineRow = {
        ...existing,
        ...patch,
        ...(recomputeNextFire
          ? {
              nextFireAt: mergedEnabled
                ? computeNextFireAt(mergedTrigger, now)
                : null,
            }
          : {}),
        updatedAt: now,
      };
      routinesById.set(routineId, row);
      return row;
    },

    async deleteRoutine(tenantId, routineId) {
      const existing = routinesById.get(routineId);
      if (
        existing === undefined ||
        existing.tenantId !== tenantId ||
        existing.deletedAt !== null
      ) {
        return false;
      }
      routinesById.set(routineId, {
        ...existing,
        deletedAt: new Date(),
        nextFireAt: null,
      });
      return true;
    },

    async listDueRoutines(now) {
      return [...routinesById.values()].filter(
        (row) =>
          row.enabled &&
          row.deletedAt === null &&
          row.nextFireAt !== null &&
          row.nextFireAt.getTime() <= now.getTime(),
      );
    },

    async claimRoutineFire(routineId, now) {
      const current = routinesById.get(routineId);
      if (
        current === undefined ||
        current.trigger === null ||
        !current.enabled ||
        current.nextFireAt === null ||
        current.nextFireAt.getTime() > now.getTime()
      ) {
        return undefined;
      }
      const claimed: RoutineRow = {
        ...current,
        nextFireAt: computeNextFireAt(current.trigger, now),
        lastFireAt: now,
      };
      routinesById.set(routineId, claimed);
      return claimed;
    },

    async compensateFailedFire(routineId, revertNextFireAt) {
      const current = routinesById.get(routineId);
      if (current === undefined) return;
      routinesById.set(routineId, {
        ...current,
        nextFireAt: revertNextFireAt,
      });
    },

    async recordRoutineRun(input) {
      const row: RoutineRunRow = { ...input, createdAt: new Date() };
      runs.push(row);
      return row;
    },

    async listRunsForRoutine(tenantId, routineId) {
      return runs
        .filter(
          (row) => row.tenantId === tenantId && row.routineId === routineId,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}
