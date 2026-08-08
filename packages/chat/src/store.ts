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
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { channelReadState, channelSettings, chatBenchSettings } from "./schema";

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
  };
}
