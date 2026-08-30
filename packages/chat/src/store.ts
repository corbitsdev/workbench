// Persistence for the two chat product tables, kept apart from route
// wiring so the HTTP layer never touches drizzle directly. `settings`
// is record-as-truth: callers read and write the whole namespaced
// jsonb blob, and this module never interprets any `chat/*` key —
// that parsing lives in `routes.ts`, next to the request boundary it
// guards.
//
// `ChatStore` is the seam `routes.ts` actually depends on; `createDrizzleChatStore`
// is its one production implementation, over the two tables in `./schema.ts`.
// Routing against the interface (rather than a raw drizzle handle) keeps the
// route layer testable with a plain in-memory fake, with no database and no
// drizzle SQL-condition internals involved.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ParticipantRecord } from "./participants";
import { participantsOf } from "./workbench-settings";
import {
  workbenchLaunch,
  workbenchReadState,
  workbenchSettings,
  chatBenchSettings,
} from "./schema";

/**
 * The drizzle handle `createDrizzleChatStore` operates against. Generic over
 * the host's schema record because every query below is table-based (the
 * chat tables from `./schema.ts` are passed to the builder directly), so the
 * host hands in its own `drizzle(sql, { schema })` instance unchanged —
 * whatever its schema — and no cast is ever needed at the call site.
 */
export type ChatDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface WorkbenchSettingsRow {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface CreateWorkbenchSettingsInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
}

export interface UpdateWorkbenchSettingsInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
}

export interface MutateWorkbenchParticipantsInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly updatedBy: string;
  /**
   * Computes the next `chat/participants` list from the current one —
   * `addParticipant`/`removeParticipant` from `./participants.ts` are
   * the two callers actually pass. Runs against a row-locked read
   * taken inside the same transaction as the write (see
   * `mutateWorkbenchParticipants`'s own doc), so it always sees the
   * latest committed list, never a snapshot a concurrent writer has
   * since moved past.
   */
  readonly mutate: (
    participants: readonly ParticipantRecord[],
  ) => ParticipantRecord[];
}

export interface ChatBenchSettingsRow {
  readonly tenantId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface UpsertBenchSettingsInput {
  readonly tenantId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
}

export interface ReadStateRow {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly lastSeenCreatedAt: Date;
  readonly lastSeenId: string;
}

export interface PutReadStateInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly lastSeenCreatedAt: Date;
  readonly lastSeenId: string;
}

/** A workbench resolved by `findWorkbenchByParticipantAddress` — just
 * enough to feed `launchAndJoinAgent`'s `existingSettings` without a
 * second `getWorkbenchSettings` round trip. */
export interface WorkbenchByParticipantAddress {
  readonly workbenchId: string;
  readonly settings: Record<string, unknown>;
}

export interface ChatStore {
  createWorkbenchSettings(
    input: CreateWorkbenchSettingsInput,
  ): Promise<WorkbenchSettingsRow>;
  getWorkbenchSettings(
    tenantId: string,
    workbenchId: string,
  ): Promise<WorkbenchSettingsRow | undefined>;
  /**
   * Removes a workbench's settings row. Used only to compensate a workbench
   * whose creation a downstream step (the agent launch) failed to
   * complete — the workbench host, tenant, and settings were all written
   * before the launch failed, so rolling the workbench back means deleting
   * each of them in turn (see `routes.ts`'s create handler).
   */
  deleteWorkbenchSettings(tenantId: string, workbenchId: string): Promise<void>;
  listWorkbenchSettings(
    tenantId: string,
    kind?: string,
  ): Promise<WorkbenchSettingsRow[]>;
  updateWorkbenchSettings(
    input: UpdateWorkbenchSettingsInput,
  ): Promise<WorkbenchSettingsRow>;
  /**
   * The targeted counterpart to `updateWorkbenchSettings` for the one
   * key every join/remove path actually changes: `chat/participants`.
   * Reads the row under a lock, folds `input.mutate` over its current
   * participant list, and writes back only that JSONB path — so two
   * overlapping calls (two concurrent invites, an invite racing a
   * removal) serialize on the row instead of each clobbering the
   * other's whole-blob snapshot. See `createDrizzleChatStore`'s
   * implementation for how the lock is taken.
   */
  mutateWorkbenchParticipants(
    input: MutateWorkbenchParticipantsInput,
  ): Promise<WorkbenchSettingsRow>;
  getBenchSettings(tenantId: string): Promise<ChatBenchSettingsRow | undefined>;
  upsertBenchSettings(
    input: UpsertBenchSettingsInput,
  ): Promise<ChatBenchSettingsRow>;
  getReadState(
    tenantId: string,
    workbenchId: string,
    principalId: string,
  ): Promise<ReadStateRow | undefined>;
  putReadState(input: PutReadStateInput): Promise<ReadStateRow>;
  /**
   * One caller's read cursors across many workbenches in a single query —
   * the bulk counterpart `GET /workbenches` needs to compute unread
   * badges without a `getReadState` round trip per row. A workbench the
   * caller has never opened is simply absent from the result.
   */
  listReadStates(
    tenantId: string,
    workbenchIds: readonly string[],
    principalId: string,
  ): Promise<ReadStateRow[]>;
  /**
   * True when `instanceId` is a workflow instance this tenant launched
   * (workbench host or invited agent). Agent mailboxes are addressed by
   * instance id, not by a `workbench_settings` row, so tenancy gates on
   * message routes must consult this as well as `getWorkbenchSettings`.
   */
  hasLaunchedInstance(tenantId: string, instanceId: string): Promise<boolean>;
  /**
   * Resolves a workflow run's own mail address back to the workbench it
   * is a participant of — a real lookup over EXISTING data (each
   * workbench's own `chat/participants` list, the same list
   * `launchAndJoinAgent`/`removeWorkbenchParticipant` already read and
   * write), never new state of its own.
   *
   * [Intx/repo gap]: there is no direct run-address -> workbench index
   * anywhere in this schema, so this scans every workbench in the
   * tenant and parses each one's participants looking for a match —
   * O(workbenches-in-tenant) per call. Fine at today's per-tenant workbench
   * counts (the same order `listWorkbenchSettings` callers already pay),
   * but a tenant with very many workbenches would want a proper index
   * (e.g. a `workbench_participants` join table keyed by address) rather
   * than this scan. Tracked as a follow-up, not fixed here.
   *
   * Returns `undefined` when `address` is not a participant of any
   * workbench in `tenantId` — a human's bare-principal-id address, a
   * stale/removed agent, or simply not this tenant's run at all.
   */
  findWorkbenchByParticipantAddress(
    tenantId: string,
    address: string,
  ): Promise<WorkbenchByParticipantAddress | undefined>;
}

/**
 * The production `ChatStore`, backed by the `workbench_settings` and
 * `workbench_read_state` tables declared in `./schema.ts`.
 */
export function createDrizzleChatStore<TSchema extends Record<string, unknown>>(
  db: ChatDb<TSchema>,
): ChatStore {
  return {
    async createWorkbenchSettings(input) {
      const now = new Date();
      const [row] = await db
        .insert(workbenchSettings)
        .values({
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          settings: input.settings,
          updatedBy: input.updatedBy,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("createWorkbenchSettings: insert returned no row");
      }
      return row as WorkbenchSettingsRow;
    },

    async getWorkbenchSettings(tenantId, workbenchId) {
      const [selected] = await db
        .select()
        .from(workbenchSettings)
        .where(
          and(
            eq(workbenchSettings.tenantId, tenantId),
            eq(workbenchSettings.workbenchId, workbenchId),
          ),
        )
        .limit(1);
      return selected as WorkbenchSettingsRow | undefined;
    },

    async deleteWorkbenchSettings(tenantId, workbenchId) {
      await db
        .delete(workbenchSettings)
        .where(
          and(
            eq(workbenchSettings.tenantId, tenantId),
            eq(workbenchSettings.workbenchId, workbenchId),
          ),
        );
    },

    async listWorkbenchSettings(tenantId, kind) {
      const rows = await db
        .select()
        .from(workbenchSettings)
        .where(eq(workbenchSettings.tenantId, tenantId));
      const typed = rows as WorkbenchSettingsRow[];
      if (kind === undefined) return typed;
      return typed.filter((row) => row.settings["chat/kind"] === kind);
    },

    async updateWorkbenchSettings(input) {
      const [row] = await db
        .update(workbenchSettings)
        .set({
          settings: input.settings,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workbenchSettings.tenantId, input.tenantId),
            eq(workbenchSettings.workbenchId, input.workbenchId),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(
          `updateWorkbenchSettings: no workbench_settings row for workbench ${input.workbenchId}`,
        );
      }
      return row as WorkbenchSettingsRow;
    },

    // Takes a `SELECT ... FOR UPDATE` row lock and writes back inside the
    // same transaction, rather than an optimistic version check with a
    // retry loop: a wall-clock version stamp (e.g. `updated_at`) can
    // collide across two transactions that start in the same tick, which
    // would silently accept the second write — the exact bug this method
    // exists to close. A real lock has no such window, and contention on
    // one workbench's settings row is negligible (two people inviting
    // into the same bench at the same instant, serialized for
    // microseconds).
    async mutateWorkbenchParticipants(input) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(workbenchSettings)
          .where(
            and(
              eq(workbenchSettings.tenantId, input.tenantId),
              eq(workbenchSettings.workbenchId, input.workbenchId),
            ),
          )
          .for("update")
          .limit(1);
        if (current === undefined) {
          throw new Error(
            `mutateWorkbenchParticipants: no workbench_settings row for workbench ${input.workbenchId}`,
          );
        }
        const currentRow = current as WorkbenchSettingsRow;
        const nextParticipants = input.mutate(
          participantsOf(currentRow.settings),
        );
        const [row] = await tx
          .update(workbenchSettings)
          .set({
            settings: sql`jsonb_set(${workbenchSettings.settings}, '{chat/participants}', ${JSON.stringify(nextParticipants)}::jsonb)`,
            updatedBy: input.updatedBy,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workbenchSettings.tenantId, input.tenantId),
              eq(workbenchSettings.workbenchId, input.workbenchId),
            ),
          )
          .returning();
        if (row === undefined) {
          throw new Error(
            `mutateWorkbenchParticipants: update returned no row for workbench ${input.workbenchId}`,
          );
        }
        return row as WorkbenchSettingsRow;
      });
    },

    async getBenchSettings(tenantId) {
      const [selected] = await db
        .select()
        .from(chatBenchSettings)
        .where(eq(chatBenchSettings.tenantId, tenantId))
        .limit(1);
      return selected as ChatBenchSettingsRow | undefined;
    },

    async upsertBenchSettings(input) {
      const [row] = await db
        .insert(chatBenchSettings)
        .values({
          tenantId: input.tenantId,
          settings: input.settings,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: chatBenchSettings.tenantId,
          set: {
            settings: input.settings,
            updatedBy: input.updatedBy,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row === undefined) {
        throw new Error("upsertBenchSettings: upsert returned no row");
      }
      return row as ChatBenchSettingsRow;
    },

    async getReadState(tenantId, workbenchId, principalId) {
      const [row] = await db
        .select()
        .from(workbenchReadState)
        .where(
          and(
            eq(workbenchReadState.tenantId, tenantId),
            eq(workbenchReadState.workbenchId, workbenchId),
            eq(workbenchReadState.principalId, principalId),
          ),
        )
        .limit(1);
      return row as ReadStateRow | undefined;
    },

    async putReadState(input) {
      const [row] = await db
        .insert(workbenchReadState)
        .values(input)
        .onConflictDoUpdate({
          target: [
            workbenchReadState.tenantId,
            workbenchReadState.workbenchId,
            workbenchReadState.principalId,
          ],
          set: {
            lastSeenCreatedAt: sql`CASE WHEN excluded.last_seen_created_at >= ${workbenchReadState.lastSeenCreatedAt} THEN excluded.last_seen_created_at ELSE ${workbenchReadState.lastSeenCreatedAt} END`,
            lastSeenId: sql`CASE WHEN excluded.last_seen_created_at >= ${workbenchReadState.lastSeenCreatedAt} THEN excluded.last_seen_id ELSE ${workbenchReadState.lastSeenId} END`,
          },
        })
        .returning();
      if (row === undefined) {
        throw new Error("putReadState: upsert returned no row");
      }
      return row as ReadStateRow;
    },

    async listReadStates(tenantId, workbenchIds, principalId) {
      if (workbenchIds.length === 0) return [];
      const rows = await db
        .select()
        .from(workbenchReadState)
        .where(
          and(
            eq(workbenchReadState.tenantId, tenantId),
            eq(workbenchReadState.principalId, principalId),
            inArray(workbenchReadState.workbenchId, workbenchIds),
          ),
        );
      return rows as ReadStateRow[];
    },

    async hasLaunchedInstance(tenantId, instanceId) {
      const [row] = await db
        .select({ instanceId: workbenchLaunch.instanceId })
        .from(workbenchLaunch)
        .where(
          and(
            eq(workbenchLaunch.tenantId, tenantId),
            eq(workbenchLaunch.instanceId, instanceId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async findWorkbenchByParticipantAddress(tenantId, address) {
      const rows = await db
        .select()
        .from(workbenchSettings)
        .where(eq(workbenchSettings.tenantId, tenantId));
      for (const row of rows as WorkbenchSettingsRow[]) {
        if (
          participantsOf(row.settings).some(
            (participant) => participant.address === address,
          )
        ) {
          return { workbenchId: row.workbenchId, settings: row.settings };
        }
      }
      return undefined;
    },
  };
}

/**
 * An in-memory `ChatStore`, for tests and any host that wants chat
 * routes without a database. Not exported from the package's public
 * surface — it is a testing convenience, not a supported deployment
 * target.
 */
export function createInMemoryChatStore(): ChatStore {
  const settingsByKey = new Map<string, WorkbenchSettingsRow>();
  const readStateByKey = new Map<string, ReadStateRow>();
  const benchSettingsByTenant = new Map<string, ChatBenchSettingsRow>();
  const launchedByKey = new Set<string>();

  const settingsKey = (tenantId: string, workbenchId: string) =>
    `${tenantId}:${workbenchId}`;
  const readStateKey = (
    tenantId: string,
    workbenchId: string,
    principalId: string,
  ) => `${tenantId}:${workbenchId}:${principalId}`;

  return {
    async createWorkbenchSettings(input) {
      const row: WorkbenchSettingsRow = {
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        settings: input.settings,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      settingsByKey.set(settingsKey(input.tenantId, input.workbenchId), row);
      return row;
    },

    async getWorkbenchSettings(tenantId, workbenchId) {
      return settingsByKey.get(settingsKey(tenantId, workbenchId));
    },

    async deleteWorkbenchSettings(tenantId, workbenchId) {
      settingsByKey.delete(settingsKey(tenantId, workbenchId));
    },

    async listWorkbenchSettings(tenantId, kind) {
      const rows = [...settingsByKey.values()].filter(
        (row) => row.tenantId === tenantId,
      );
      if (kind === undefined) return rows;
      return rows.filter((row) => row.settings["chat/kind"] === kind);
    },

    async updateWorkbenchSettings(input) {
      const key = settingsKey(input.tenantId, input.workbenchId);
      const existing = settingsByKey.get(key);
      if (existing === undefined) {
        throw new Error(
          `updateWorkbenchSettings: no workbench_settings row for workbench ${input.workbenchId}`,
        );
      }
      const row: WorkbenchSettingsRow = {
        ...existing,
        settings: input.settings,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      settingsByKey.set(key, row);
      return row;
    },

    // No real concurrency to guard against in-process, but the shape
    // matches the drizzle store exactly: read the current list, fold
    // `mutate` over it, write only `chat/participants` back.
    async mutateWorkbenchParticipants(input) {
      const key = settingsKey(input.tenantId, input.workbenchId);
      const existing = settingsByKey.get(key);
      if (existing === undefined) {
        throw new Error(
          `mutateWorkbenchParticipants: no workbench_settings row for workbench ${input.workbenchId}`,
        );
      }
      const nextParticipants = input.mutate(participantsOf(existing.settings));
      const row: WorkbenchSettingsRow = {
        ...existing,
        settings: {
          ...existing.settings,
          "chat/participants": nextParticipants,
        },
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      settingsByKey.set(key, row);
      return row;
    },

    async getBenchSettings(tenantId) {
      return benchSettingsByTenant.get(tenantId);
    },

    async upsertBenchSettings(input) {
      const row: ChatBenchSettingsRow = {
        tenantId: input.tenantId,
        settings: input.settings,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      benchSettingsByTenant.set(input.tenantId, row);
      return row;
    },

    async getReadState(tenantId, workbenchId, principalId) {
      return readStateByKey.get(
        readStateKey(tenantId, workbenchId, principalId),
      );
    },

    async putReadState(input) {
      const key = readStateKey(
        input.tenantId,
        input.workbenchId,
        input.principalId,
      );
      const existing = readStateByKey.get(key);
      if (
        existing !== undefined &&
        existing.lastSeenCreatedAt > input.lastSeenCreatedAt
      ) {
        return existing;
      }
      const row: ReadStateRow = { ...input };
      readStateByKey.set(key, row);
      return row;
    },

    async listReadStates(tenantId, workbenchIds, principalId) {
      return workbenchIds.flatMap((workbenchId) => {
        const row = readStateByKey.get(
          readStateKey(tenantId, workbenchId, principalId),
        );
        return row === undefined ? [] : [row];
      });
    },

    async hasLaunchedInstance(tenantId, instanceId) {
      return launchedByKey.has(`${tenantId}:${instanceId}`);
    },

    async findWorkbenchByParticipantAddress(tenantId, address) {
      for (const row of settingsByKey.values()) {
        if (row.tenantId !== tenantId) continue;
        if (
          participantsOf(row.settings).some(
            (participant) => participant.address === address,
          )
        ) {
          return { workbenchId: row.workbenchId, settings: row.settings };
        }
      }
      return undefined;
    },
  };
}
