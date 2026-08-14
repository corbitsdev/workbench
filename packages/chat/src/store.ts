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
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  channelLaunch,
  channelReadState,
  channelSettings,
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

export interface ChannelSettingsRow {
  readonly tenantId: string;
  readonly channelId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface CreateChannelSettingsInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
}

export interface UpdateChannelSettingsInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
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
  readonly channelId: string;
  readonly principalId: string;
  readonly lastSeenCreatedAt: Date;
  readonly lastSeenId: string;
}

export interface PutReadStateInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly lastSeenCreatedAt: Date;
  readonly lastSeenId: string;
}

export interface ChatStore {
  createChannelSettings(
    input: CreateChannelSettingsInput,
  ): Promise<ChannelSettingsRow>;
  getChannelSettings(
    tenantId: string,
    channelId: string,
  ): Promise<ChannelSettingsRow | undefined>;
  /**
   * Removes a channel's settings row. Used only to compensate a channel
   * whose creation a downstream step (the agent launch) failed to
   * complete — the channel host, tenant, and settings were all written
   * before the launch failed, so rolling the channel back means deleting
   * each of them in turn (see `routes.ts`'s create handler).
   */
  deleteChannelSettings(tenantId: string, channelId: string): Promise<void>;
  listChannelSettings(
    tenantId: string,
    kind?: string,
  ): Promise<ChannelSettingsRow[]>;
  updateChannelSettings(
    input: UpdateChannelSettingsInput,
  ): Promise<ChannelSettingsRow>;
  getBenchSettings(tenantId: string): Promise<ChatBenchSettingsRow | undefined>;
  upsertBenchSettings(
    input: UpsertBenchSettingsInput,
  ): Promise<ChatBenchSettingsRow>;
  getReadState(
    tenantId: string,
    channelId: string,
    principalId: string,
  ): Promise<ReadStateRow | undefined>;
  putReadState(input: PutReadStateInput): Promise<ReadStateRow>;
  /**
   * One caller's read cursors across many channels in a single query —
   * the bulk counterpart `GET /channels` needs to compute unread
   * badges without a `getReadState` round trip per row. A channel the
   * caller has never opened is simply absent from the result.
   */
  listReadStates(
    tenantId: string,
    channelIds: readonly string[],
    principalId: string,
  ): Promise<ReadStateRow[]>;
  /**
   * True when `instanceId` is a workflow instance this tenant launched
   * (channel host or invited agent). Agent mailboxes are addressed by
   * instance id, not by a `channel_settings` row, so tenancy gates on
   * message routes must consult this as well as `getChannelSettings`.
   */
  hasLaunchedInstance(tenantId: string, instanceId: string): Promise<boolean>;
}

/**
 * The production `ChatStore`, backed by the `channel_settings` and
 * `channel_read_state` tables declared in `./schema.ts`.
 */
export function createDrizzleChatStore<TSchema extends Record<string, unknown>>(
  db: ChatDb<TSchema>,
): ChatStore {
  return {
    async createChannelSettings(input) {
      const now = new Date();
      const [row] = await db
        .insert(channelSettings)
        .values({
          tenantId: input.tenantId,
          channelId: input.channelId,
          settings: input.settings,
          updatedBy: input.updatedBy,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("createChannelSettings: insert returned no row");
      }
      return row as ChannelSettingsRow;
    },

    async getChannelSettings(tenantId, channelId) {
      const [selected] = await db
        .select()
        .from(channelSettings)
        .where(
          and(
            eq(channelSettings.tenantId, tenantId),
            eq(channelSettings.channelId, channelId),
          ),
        )
        .limit(1);
      return selected as ChannelSettingsRow | undefined;
    },

    async deleteChannelSettings(tenantId, channelId) {
      await db
        .delete(channelSettings)
        .where(
          and(
            eq(channelSettings.tenantId, tenantId),
            eq(channelSettings.channelId, channelId),
          ),
        );
    },

    async listChannelSettings(tenantId, kind) {
      const rows = await db
        .select()
        .from(channelSettings)
        .where(eq(channelSettings.tenantId, tenantId));
      const typed = rows as ChannelSettingsRow[];
      if (kind === undefined) return typed;
      return typed.filter((row) => row.settings["chat/kind"] === kind);
    },

    async updateChannelSettings(input) {
      const [row] = await db
        .update(channelSettings)
        .set({
          settings: input.settings,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(channelSettings.tenantId, input.tenantId),
            eq(channelSettings.channelId, input.channelId),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(
          `updateChannelSettings: no channel_settings row for channel ${input.channelId}`,
        );
      }
      return row as ChannelSettingsRow;
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

    async getReadState(tenantId, channelId, principalId) {
      const [row] = await db
        .select()
        .from(channelReadState)
        .where(
          and(
            eq(channelReadState.tenantId, tenantId),
            eq(channelReadState.channelId, channelId),
            eq(channelReadState.principalId, principalId),
          ),
        )
        .limit(1);
      return row as ReadStateRow | undefined;
    },

    async putReadState(input) {
      const [row] = await db
        .insert(channelReadState)
        .values(input)
        .onConflictDoUpdate({
          target: [
            channelReadState.tenantId,
            channelReadState.channelId,
            channelReadState.principalId,
          ],
          set: {
            lastSeenCreatedAt: input.lastSeenCreatedAt,
            lastSeenId: input.lastSeenId,
          },
        })
        .returning();
      if (row === undefined) {
        throw new Error("putReadState: upsert returned no row");
      }
      return row as ReadStateRow;
    },

    async listReadStates(tenantId, channelIds, principalId) {
      if (channelIds.length === 0) return [];
      const rows = await db
        .select()
        .from(channelReadState)
        .where(
          and(
            eq(channelReadState.tenantId, tenantId),
            eq(channelReadState.principalId, principalId),
            inArray(channelReadState.channelId, channelIds),
          ),
        );
      return rows as ReadStateRow[];
    },

    async hasLaunchedInstance(tenantId, instanceId) {
      const [row] = await db
        .select({ instanceId: channelLaunch.instanceId })
        .from(channelLaunch)
        .where(
          and(
            eq(channelLaunch.tenantId, tenantId),
            eq(channelLaunch.instanceId, instanceId),
          ),
        )
        .limit(1);
      return row !== undefined;
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
  const settingsByKey = new Map<string, ChannelSettingsRow>();
  const readStateByKey = new Map<string, ReadStateRow>();
  const benchSettingsByTenant = new Map<string, ChatBenchSettingsRow>();
  const launchedByKey = new Set<string>();

  const settingsKey = (tenantId: string, channelId: string) =>
    `${tenantId}:${channelId}`;
  const readStateKey = (
    tenantId: string,
    channelId: string,
    principalId: string,
  ) => `${tenantId}:${channelId}:${principalId}`;

  return {
    async createChannelSettings(input) {
      const row: ChannelSettingsRow = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        settings: input.settings,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      settingsByKey.set(settingsKey(input.tenantId, input.channelId), row);
      return row;
    },

    async getChannelSettings(tenantId, channelId) {
      return settingsByKey.get(settingsKey(tenantId, channelId));
    },

    async deleteChannelSettings(tenantId, channelId) {
      settingsByKey.delete(settingsKey(tenantId, channelId));
    },

    async listChannelSettings(tenantId, kind) {
      const rows = [...settingsByKey.values()].filter(
        (row) => row.tenantId === tenantId,
      );
      if (kind === undefined) return rows;
      return rows.filter((row) => row.settings["chat/kind"] === kind);
    },

    async updateChannelSettings(input) {
      const key = settingsKey(input.tenantId, input.channelId);
      const existing = settingsByKey.get(key);
      if (existing === undefined) {
        throw new Error(
          `updateChannelSettings: no channel_settings row for channel ${input.channelId}`,
        );
      }
      const row: ChannelSettingsRow = {
        ...existing,
        settings: input.settings,
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

    async getReadState(tenantId, channelId, principalId) {
      return readStateByKey.get(readStateKey(tenantId, channelId, principalId));
    },

    async putReadState(input) {
      const row: ReadStateRow = { ...input };
      readStateByKey.set(
        readStateKey(input.tenantId, input.channelId, input.principalId),
        row,
      );
      return row;
    },

    async listReadStates(tenantId, channelIds, principalId) {
      return channelIds.flatMap((channelId) => {
        const row = readStateByKey.get(
          readStateKey(tenantId, channelId, principalId),
        );
        return row === undefined ? [] : [row];
      });
    },

    async hasLaunchedInstance(tenantId, instanceId) {
      return launchedByKey.has(`${tenantId}:${instanceId}`);
    },
  };
}
