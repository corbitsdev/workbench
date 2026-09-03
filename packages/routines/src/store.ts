// Persistence for the two routines tables, kept apart from route
// wiring the same way `@corbits/chat`'s `store.ts` separates
// persistence from `routes.ts`. `RoutineStore` is the seam the route
// layer depends on; `createDrizzleRoutineStore` is its one production
// implementation, over the tables in `./schema.ts`.
import { and, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";

import { routine, routineRun } from "./schema";
import { computeNextFireAt, type RoutineTriggerT } from "./trigger";

export type RoutineDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export type RoutineScope = "personal" | "bench";

/** After this many consecutive launch failures, the routine is dead-lettered. */
export const MAX_ROUTINE_FIRE_FAILURES = 5;
/** First retry delay after a failed launch (1 minute). */
export const ROUTINE_FIRE_BACKOFF_BASE_MS = 60_000;
/** Cap on exponential backoff between retries (1 hour). */
export const ROUTINE_FIRE_BACKOFF_MAX_MS = 60 * 60 * 1000;

/**
 * Delay until the next retry after `consecutiveFailures` failures have
 * already been recorded for this routine (1-based: first failure → 1).
 */
export function backoffMsForFailure(consecutiveFailures: number): number {
  const exp = Math.max(0, consecutiveFailures - 1);
  return Math.min(
    ROUTINE_FIRE_BACKOFF_BASE_MS * 2 ** exp,
    ROUTINE_FIRE_BACKOFF_MAX_MS,
  );
}

export interface RoutineRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly definitionAssetId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: RoutineScope;
  readonly input: Record<string, unknown>;
  readonly enabled: boolean;
  readonly deliveryWorkbenchId: string | null;
  readonly createdBy: string;
  readonly nextFireAt: Date | null;
  readonly lastFireAt: Date | null;
  readonly deletedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly deadLetteredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** See `schema.ts`' `preset_key` column doc comment. `null` for an
   * ordinary, person-authored routine. */
  readonly presetKey: string | null;
}

export interface CreateRoutineInput {
  readonly tenantId: string;
  readonly name: string;
  readonly definitionAssetId: string;
  readonly trigger: RoutineTriggerT;
  readonly scope: RoutineScope;
  readonly input: Record<string, unknown>;
  readonly deliveryWorkbenchId?: string | null;
  readonly createdBy: string;
  readonly presetKey?: string | null;
}

/** `createRoutineIfAbsent`'s own input: `presetKey` is the whole point
 * of this call (mandatory, unlike `CreateRoutineInput`'s optional
 * field), since it is the identity the create-if-absent conflict
 * target matches on. `enabled` is explicit here — a seeded preset is
 * born disabled, never flipped after the fact — where a plain create
 * is always born enabled. */
export type CreateRoutineIfAbsentInput = Omit<
  CreateRoutineInput,
  "presetKey"
> & { readonly presetKey: string; readonly enabled: boolean };

/**
 * `existing` is any call that found a live row for this
 * `(tenantId, presetKey)` — including the loser of a genuine race —
 * which must not re-announce or re-fire. `tombstoned` means a member
 * deleted this preset's routine: absence is their choice, and the
 * create is refused rather than resurrecting the row.
 */
export type CreateRoutineIfAbsentResult =
  | { readonly outcome: "created"; readonly row: RoutineRow }
  | { readonly outcome: "existing"; readonly row: RoutineRow }
  | { readonly outcome: "tombstoned" };

export interface UpdateRoutineInput {
  readonly name?: string;
  /**
   * Retargets the routine to a different workflow asset (CL-7359) — the
   * same single UPDATE as every other field here, so a launch that reads
   * the row once (`resolveLaunchableDefinition` at fire time,
   * `./target.ts`) never sees a half-applied retarget. The route
   * validates this through `resolveLaunchableDefinition` before it ever
   * reaches the store (see `./routes.ts`'s `rejectUnlaunchableTarget`) —
   * see `CreateRoutineInput.definitionAssetId`'s own doc comment.
   */
  readonly definitionAssetId?: string;
  readonly trigger?: RoutineTriggerT;
  readonly input?: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly deliveryWorkbenchId?: string | null;
}

export interface RoutineRunRow {
  readonly tenantId: string;
  readonly routineId: string;
  readonly runId: string;
  readonly triggeredBy: string;
  readonly error: string | null;
  readonly createdAt: Date;
}

export interface MarkFailedFireResult {
  readonly deadLettered: boolean;
  readonly nextFireAt: Date | null;
  readonly consecutiveFailures: number;
}

export interface RoutineStore {
  createRoutine(input: CreateRoutineInput): Promise<RoutineRow>;
  /**
   * Real create-if-absent, keyed on `(tenantId, presetKey)`: a single
   * atomic `INSERT ... ON CONFLICT DO NOTHING` (backed by
   * `routine_tenant_preset_key_idx`, migrations.ts' 0005), never a
   * check-then-insert. Two overlapping calls with the same
   * `(tenantId, presetKey)` — including genuinely concurrent ones — are
   * guaranteed exactly one winner (`created`) and any number of losers
   * (`existing`, returning the winner's own row), never two rows. A
   * soft-deleted row for the key is a tombstone: the create is refused
   * (`tombstoned`) rather than resurrecting what a member deleted.
   */
  createRoutineIfAbsent(
    input: CreateRoutineIfAbsentInput,
  ): Promise<CreateRoutineIfAbsentResult>;
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
   * Failed launches that never produced a platform run still get a row
   * (`triggeredBy: "schedule-failed"`, synthetic `runId`, `error` set).
   */
  recordRoutineRun(input: {
    tenantId: string;
    routineId: string;
    runId: string;
    triggeredBy: string;
    error?: string | null;
  }): Promise<RoutineRunRow>;
  listRunsForRoutine(
    tenantId: string,
    routineId: string,
  ): Promise<RoutineRunRow[]>;
  /**
   * Every enabled, timer-triggered, non-dead-lettered routine whose
   * `nextFireAt` is at or before `now` — across every tenant, the one
   * cross-tenant read a scheduler needs and no per-request route ever
   * does. "At or before," not "equal to": a fire that was due while
   * nothing was polling is still due, not skipped.
   */
  listDueRoutines(now: Date): Promise<RoutineRow[]>;
  /**
   * Atomically claims `routineId`'s current due fire: advances
   * `nextFireAt` to the trigger's following occurrence and stamps
   * `lastFireAt`, but only if the row is still claimable at the moment
   * of the write (enabled, not deleted, not dead-lettered, due). A
   * second caller racing the same fire loses — the first claim already
   * moved `nextFireAt` into the future, so the second claim's
   * conditional write matches no row and returns `undefined`.
   */
  claimRoutineFire(
    routineId: string,
    now: Date,
  ): Promise<RoutineRow | undefined>;
  /**
   * After a claimed fire's launch fails: increments
   * `consecutiveFailures`, records a `schedule-failed` run with the
   * reason, and either schedules a backoff retry or dead-letters the
   * routine once `MAX_ROUTINE_FIRE_FAILURES` is reached.
   *
   * Conditional on `nextFireAt` still being `claimedNextFireAt` — the
   * value the claim itself wrote. If a trigger edit landed during the
   * failure window, that newer value wins and this is a no-op
   * (`undefined`).
   */
  markFailedFire(input: {
    routineId: string;
    tenantId: string;
    claimedNextFireAt: Date;
    failedAt: Date;
    reason: string;
  }): Promise<MarkFailedFireResult | undefined>;
  /** Clear failure counters after a successful fire. */
  clearFireFailures(routineId: string): Promise<void>;
}

function mapRoutineRow(row: typeof routine.$inferSelect): RoutineRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    definitionAssetId: row.definitionAssetId,
    trigger: row.trigger as RoutineTriggerT,
    scope: row.scope as RoutineScope,
    input: row.input as Record<string, unknown>,
    enabled: row.enabled,
    deliveryWorkbenchId: row.deliveryWorkbenchId,
    createdBy: row.createdBy,
    nextFireAt: row.nextFireAt,
    lastFireAt: row.lastFireAt,
    deletedAt: row.deletedAt,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    deadLetteredAt: row.deadLetteredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    presetKey: row.presetKey ?? null,
  };
}

function mapRunRow(row: typeof routineRun.$inferSelect): RoutineRunRow {
  return {
    tenantId: row.tenantId,
    routineId: row.routineId,
    runId: row.runId,
    triggeredBy: row.triggeredBy,
    error: row.error ?? null,
    createdAt: row.createdAt,
  };
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
          id: generateId("workflowRun"),
          tenantId: input.tenantId,
          name: input.name,
          definitionAssetId: input.definitionAssetId,
          trigger: input.trigger,
          scope: input.scope,
          input: input.input,
          enabled: true,
          deliveryWorkbenchId: input.deliveryWorkbenchId ?? null,
          createdBy: input.createdBy,
          nextFireAt: computeNextFireAt(input.trigger, now),
          lastFireAt: null,
          deletedAt: null,
          consecutiveFailures: 0,
          deadLetteredAt: null,
          createdAt: now,
          updatedAt: now,
          presetKey: input.presetKey ?? null,
        })
        .returning();
      if (row === undefined) {
        throw new Error("createRoutine: insert returned no row");
      }
      return mapRoutineRow(row);
    },

    async createRoutineIfAbsent(input) {
      // A tombstone means a member deleted this preset's routine:
      // absence is their choice, and the create is refused rather than
      // resurrecting the row. A live row still outranks a tombstone
      // (delete-then-reseed-then-delete leaves both) — the insert's own
      // conflict target settles that case below. Tombstones are never
      // un-deleted, so this read cannot go stale against the insert.
      const [tombstone] = await db
        .select({ id: routine.id })
        .from(routine)
        .where(
          and(
            eq(routine.tenantId, input.tenantId),
            eq(routine.presetKey, input.presetKey),
            isNotNull(routine.deletedAt),
          ),
        )
        .limit(1);
      if (tombstone !== undefined) {
        const [live] = await db
          .select()
          .from(routine)
          .where(
            and(
              eq(routine.tenantId, input.tenantId),
              eq(routine.presetKey, input.presetKey),
              isNull(routine.deletedAt),
            ),
          )
          .limit(1);
        return live === undefined
          ? { outcome: "tombstoned" }
          : { outcome: "existing", row: mapRoutineRow(live) };
      }

      const now = new Date();
      const [inserted] = await db
        .insert(routine)
        .values({
          id: generateId("workflowRun"),
          tenantId: input.tenantId,
          name: input.name,
          definitionAssetId: input.definitionAssetId,
          trigger: input.trigger,
          scope: input.scope,
          input: input.input,
          enabled: input.enabled,
          deliveryWorkbenchId: input.deliveryWorkbenchId ?? null,
          createdBy: input.createdBy,
          nextFireAt: computeNextFireAt(input.trigger, now),
          lastFireAt: null,
          deletedAt: null,
          consecutiveFailures: 0,
          deadLetteredAt: null,
          createdAt: now,
          updatedAt: now,
          presetKey: input.presetKey,
        })
        .onConflictDoNothing({
          target: [routine.tenantId, routine.presetKey],
          where: sql`${routine.presetKey} is not null and ${routine.deletedAt} is null`,
        })
        .returning();
      if (inserted !== undefined) {
        return { outcome: "created", row: mapRoutineRow(inserted) };
      }

      // Lost the race (or a genuine re-seed): the winner's row is the
      // one this `(tenantId, presetKey)` now resolves to.
      const [existing] = await db
        .select()
        .from(routine)
        .where(
          and(
            eq(routine.tenantId, input.tenantId),
            eq(routine.presetKey, input.presetKey),
            isNull(routine.deletedAt),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        throw new Error(
          `createRoutineIfAbsent: insert conflicted for preset key ` +
            `${JSON.stringify(input.presetKey)} but no existing row was found`,
        );
      }
      return { outcome: "existing", row: mapRoutineRow(existing) };
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
      return row === undefined ? undefined : mapRoutineRow(row);
    },

    async getRoutineIncludingDeleted(tenantId, routineId) {
      const [row] = await db
        .select()
        .from(routine)
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .limit(1);
      return row === undefined ? undefined : mapRoutineRow(row);
    },

    async listRoutines(tenantId) {
      const rows = await db
        .select()
        .from(routine)
        .where(and(eq(routine.tenantId, tenantId), isNull(routine.deletedAt)));
      return rows.map(mapRoutineRow);
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
      const clearFailures =
        patch.enabled === true || patch.trigger !== undefined;
      const mergedTrigger =
        patch.trigger !== undefined
          ? patch.trigger
          : (existing.trigger as RoutineTriggerT);
      const mergedEnabled =
        patch.enabled !== undefined ? patch.enabled : existing.enabled;
      let update: UpdateRoutineInput & {
        updatedAt: Date;
        nextFireAt?: Date | null;
        consecutiveFailures?: number;
        deadLetteredAt?: Date | null;
      } = { ...patch, updatedAt: now };
      if (recomputeNextFire) {
        update = {
          ...update,
          nextFireAt: mergedEnabled
            ? computeNextFireAt(mergedTrigger, now)
            : null,
        };
      }
      if (clearFailures) {
        update = { ...update, consecutiveFailures: 0, deadLetteredAt: null };
      }
      const [row] = await db
        .update(routine)
        .set(update)
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .returning();
      if (row === undefined) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      return mapRoutineRow(row);
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
            isNull(routine.deadLetteredAt),
            lte(routine.nextFireAt, now),
          ),
        );
      return rows.map(mapRoutineRow);
    },

    async claimRoutineFire(routineId, now) {
      // A transaction with `FOR UPDATE` locks the row for the read
      // that decides `nextFireAt`'s new value, so a concurrent `PATCH`
      // of this routine's trigger can't sneak in between "read the
      // trigger" and "write the value computed from it".
      return await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(routine)
          .where(eq(routine.id, routineId))
          .for("update")
          .limit(1);
        if (
          current === undefined ||
          current.trigger === null ||
          current.deletedAt !== null ||
          current.deadLetteredAt !== null ||
          !current.enabled ||
          current.nextFireAt === null ||
          current.nextFireAt.getTime() > now.getTime()
        ) {
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
              isNull(routine.deletedAt),
              isNull(routine.deadLetteredAt),
              lte(routine.nextFireAt, now),
            ),
          )
          .returning();
        return claimed === undefined ? undefined : mapRoutineRow(claimed);
      });
    },

    async markFailedFire(input) {
      return await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(routine)
          .where(eq(routine.id, input.routineId))
          .for("update")
          .limit(1);
        if (current === undefined) return undefined;
        if (
          current.nextFireAt?.getTime() !== input.claimedNextFireAt.getTime()
        ) {
          return undefined;
        }

        const consecutiveFailures = (current.consecutiveFailures ?? 0) + 1;
        const deadLettered = consecutiveFailures >= MAX_ROUTINE_FIRE_FAILURES;
        const nextFireAt = deadLettered
          ? null
          : new Date(
              input.failedAt.getTime() +
                backoffMsForFailure(consecutiveFailures),
            );

        const [updated] = await tx
          .update(routine)
          .set({
            consecutiveFailures,
            nextFireAt,
            deadLetteredAt: deadLettered ? input.failedAt : null,
            updatedAt: input.failedAt,
          })
          .where(
            and(
              eq(routine.id, input.routineId),
              eq(routine.nextFireAt, input.claimedNextFireAt),
            ),
          )
          .returning();
        if (updated === undefined) return undefined;

        await tx.insert(routineRun).values({
          tenantId: input.tenantId,
          routineId: input.routineId,
          runId: generateId("workflowRun"),
          triggeredBy: "schedule-failed",
          error: input.reason,
          createdAt: input.failedAt,
        });

        return {
          deadLettered,
          nextFireAt,
          consecutiveFailures,
        };
      });
    },

    async clearFireFailures(routineId) {
      await db
        .update(routine)
        .set({ consecutiveFailures: 0, deadLetteredAt: null })
        .where(eq(routine.id, routineId));
    },

    async recordRoutineRun(input) {
      const [row] = await db
        .insert(routineRun)
        .values({
          tenantId: input.tenantId,
          routineId: input.routineId,
          runId: input.runId,
          triggeredBy: input.triggeredBy,
          error: input.error ?? null,
        })
        .returning();
      if (row === undefined) {
        throw new Error("recordRoutineRun: insert returned no row");
      }
      return mapRunRow(row);
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
      return rows.map(mapRunRow);
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
        id: generateId("workflowRun"),
        tenantId: input.tenantId,
        name: input.name,
        definitionAssetId: input.definitionAssetId,
        trigger: input.trigger,
        scope: input.scope,
        input: input.input,
        enabled: true,
        deliveryWorkbenchId: input.deliveryWorkbenchId ?? null,
        createdBy: input.createdBy,
        nextFireAt: computeNextFireAt(input.trigger, now),
        lastFireAt: null,
        deletedAt: null,
        consecutiveFailures: 0,
        deadLetteredAt: null,
        createdAt: now,
        updatedAt: now,
        presetKey: input.presetKey ?? null,
      };
      routinesById.set(row.id, row);
      return row;
    },

    async createRoutineIfAbsent(input) {
      const rowsForKey = [...routinesById.values()].filter(
        (row) =>
          row.tenantId === input.tenantId && row.presetKey === input.presetKey,
      );
      const existing = rowsForKey.find((row) => row.deletedAt === null);
      if (existing !== undefined) {
        return { outcome: "existing", row: existing };
      }
      if (rowsForKey.some((row) => row.deletedAt !== null)) {
        return { outcome: "tombstoned" };
      }
      const now = new Date();
      const row: RoutineRow = {
        id: generateId("workflowRun"),
        tenantId: input.tenantId,
        name: input.name,
        definitionAssetId: input.definitionAssetId,
        trigger: input.trigger,
        scope: input.scope,
        input: input.input,
        enabled: input.enabled,
        deliveryWorkbenchId: input.deliveryWorkbenchId ?? null,
        createdBy: input.createdBy,
        nextFireAt: computeNextFireAt(input.trigger, now),
        lastFireAt: null,
        deletedAt: null,
        consecutiveFailures: 0,
        deadLetteredAt: null,
        createdAt: now,
        updatedAt: now,
        presetKey: input.presetKey,
      };
      routinesById.set(row.id, row);
      return { outcome: "created", row };
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
      const clearFailures =
        patch.enabled === true || patch.trigger !== undefined;
      const mergedTrigger =
        patch.trigger !== undefined ? patch.trigger : existing.trigger;
      const mergedEnabled =
        patch.enabled !== undefined ? patch.enabled : existing.enabled;
      let row: RoutineRow = { ...existing, ...patch, updatedAt: now };
      if (recomputeNextFire) {
        row = {
          ...row,
          nextFireAt: mergedEnabled
            ? computeNextFireAt(mergedTrigger, now)
            : null,
        };
      }
      if (clearFailures) {
        row = { ...row, consecutiveFailures: 0, deadLetteredAt: null };
      }
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
          row.deadLetteredAt === null &&
          row.nextFireAt !== null &&
          row.nextFireAt.getTime() <= now.getTime(),
      );
    },

    async claimRoutineFire(routineId, now) {
      const current = routinesById.get(routineId);
      if (
        current === undefined ||
        current.trigger === null ||
        current.deletedAt !== null ||
        current.deadLetteredAt !== null ||
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

    async markFailedFire(input) {
      const current = routinesById.get(input.routineId);
      if (current === undefined) return undefined;
      if (current.nextFireAt?.getTime() !== input.claimedNextFireAt.getTime()) {
        return undefined;
      }

      const consecutiveFailures = current.consecutiveFailures + 1;
      const deadLettered = consecutiveFailures >= MAX_ROUTINE_FIRE_FAILURES;
      const nextFireAt = deadLettered
        ? null
        : new Date(
            input.failedAt.getTime() + backoffMsForFailure(consecutiveFailures),
          );

      routinesById.set(input.routineId, {
        ...current,
        consecutiveFailures,
        nextFireAt,
        deadLetteredAt: deadLettered ? input.failedAt : null,
        updatedAt: input.failedAt,
      });

      runs.push({
        tenantId: input.tenantId,
        routineId: input.routineId,
        runId: generateId("workflowRun"),
        triggeredBy: "schedule-failed",
        error: input.reason,
        createdAt: input.failedAt,
      });

      return { deadLettered, nextFireAt, consecutiveFailures };
    },

    async clearFireFailures(routineId) {
      const current = routinesById.get(routineId);
      if (current === undefined) return;
      routinesById.set(routineId, {
        ...current,
        consecutiveFailures: 0,
        deadLetteredAt: null,
      });
    },

    async recordRoutineRun(input) {
      const row: RoutineRunRow = {
        tenantId: input.tenantId,
        routineId: input.routineId,
        runId: input.runId,
        triggeredBy: input.triggeredBy,
        error: input.error ?? null,
        createdAt: new Date(),
      };
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
