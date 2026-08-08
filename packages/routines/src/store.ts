// Persistence for the two routines tables, kept apart from route
// wiring the same way `@corbits/chat`'s `store.ts` separates
// persistence from `routes.ts`. `RoutineStore` is the seam the route
// layer depends on; `createDrizzleRoutineStore` is its one production
// implementation, over the tables in `./schema.ts`.
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { hexEncode } from "@intx/types";

import { routine, routineRun } from "./schema";
import type { RoutineTriggerT } from "./trigger";

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
  getRoutine(
    tenantId: string,
    routineId: string,
  ): Promise<RoutineRow | undefined>;
  listRoutines(tenantId: string): Promise<RoutineRow[]>;
  updateRoutine(
    tenantId: string,
    routineId: string,
    patch: UpdateRoutineInput,
  ): Promise<RoutineRow>;
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
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .limit(1);
      return row as RoutineRow | undefined;
    },

    async listRoutines(tenantId) {
      const rows = await db
        .select()
        .from(routine)
        .where(eq(routine.tenantId, tenantId));
      return rows as RoutineRow[];
    },

    async updateRoutine(tenantId, routineId, patch) {
      const [row] = await db
        .update(routine)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .returning();
      if (row === undefined) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      return row as RoutineRow;
    },

    async deleteRoutine(tenantId, routineId) {
      const deleted = await db
        .delete(routine)
        .where(and(eq(routine.tenantId, tenantId), eq(routine.id, routineId)))
        .returning();
      return deleted.length > 0;
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
        createdAt: now,
        updatedAt: now,
      };
      routinesById.set(row.id, row);
      return row;
    },

    async getRoutine(tenantId, routineId) {
      const row = routinesById.get(routineId);
      return row?.tenantId === tenantId ? row : undefined;
    },

    async listRoutines(tenantId) {
      return [...routinesById.values()].filter(
        (row) => row.tenantId === tenantId,
      );
    },

    async updateRoutine(tenantId, routineId, patch) {
      const existing = routinesById.get(routineId);
      if (existing === undefined || existing.tenantId !== tenantId) {
        throw new Error(`updateRoutine: no routine row for id ${routineId}`);
      }
      const row: RoutineRow = { ...existing, ...patch, updatedAt: new Date() };
      routinesById.set(routineId, row);
      return row;
    },

    async deleteRoutine(tenantId, routineId) {
      const existing = routinesById.get(routineId);
      if (existing === undefined || existing.tenantId !== tenantId) {
        return false;
      }
      routinesById.delete(routineId);
      return true;
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
