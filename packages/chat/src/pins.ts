// Persistence for pinned messages — one row per pinned message, see
// `./schema.ts`'s `pinnedMessages` for why there is no boolean column:
// the row's existence is the pin. `pinMessage` is an idempotent upsert
// (pinning an already-pinned message just refreshes who/when) and
// `unpinMessage` is a plain delete; `listPins` is the one batched read
// the pinned strip and `GET /channels/:id/pins` both need — every
// pinned row for a channel in a single query.

import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { pinnedMessages } from "./schema";

export interface PinRow {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly pinnedBy: string;
  readonly pinnedAt: Date;
}

export interface PinMessageInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly pinnedBy: string;
}

export interface PinStore {
  pinMessage(input: PinMessageInput): Promise<PinRow>;
  unpinMessage(
    tenantId: string,
    channelId: string,
    messageId: string,
  ): Promise<void>;
  /** Every pinned message in a channel, newest pin first — the pinned
   * strip's own read, and the set `GET /channels/:id/messages` marks
   * each page item against. */
  listPins(tenantId: string, channelId: string): Promise<readonly PinRow[]>;
}

function pinKey(tenantId: string, channelId: string, messageId: string) {
  return `${tenantId}::${channelId}::${messageId}`;
}

export function createInMemoryPinStore(): PinStore {
  const rows = new Map<string, PinRow>();

  return {
    async pinMessage(input) {
      const row: PinRow = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        messageId: input.messageId,
        pinnedBy: input.pinnedBy,
        pinnedAt: new Date(),
      };
      rows.set(pinKey(input.tenantId, input.channelId, input.messageId), row);
      return row;
    },

    async unpinMessage(tenantId, channelId, messageId) {
      rows.delete(pinKey(tenantId, channelId, messageId));
    },

    async listPins(tenantId, channelId) {
      return [...rows.values()]
        .filter(
          (row) => row.tenantId === tenantId && row.channelId === channelId,
        )
        .sort((a, b) => b.pinnedAt.getTime() - a.pinnedAt.getTime());
    },
  };
}

export type PinDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export function createDrizzlePinStore<TSchema extends Record<string, unknown>>(
  db: PinDb<TSchema>,
): PinStore {
  return {
    async pinMessage(input) {
      const now = new Date();
      const [row] = await db
        .insert(pinnedMessages)
        .values({
          tenantId: input.tenantId,
          channelId: input.channelId,
          messageId: input.messageId,
          pinnedBy: input.pinnedBy,
          pinnedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            pinnedMessages.tenantId,
            pinnedMessages.channelId,
            pinnedMessages.messageId,
          ],
          set: { pinnedBy: input.pinnedBy, pinnedAt: now },
        })
        .returning();
      if (row === undefined) {
        throw new Error("pinMessage: upsert returned no row");
      }
      return row as PinRow;
    },

    async unpinMessage(tenantId, channelId, messageId) {
      await db
        .delete(pinnedMessages)
        .where(
          and(
            eq(pinnedMessages.tenantId, tenantId),
            eq(pinnedMessages.channelId, channelId),
            eq(pinnedMessages.messageId, messageId),
          ),
        );
    },

    async listPins(tenantId, channelId) {
      const rows = await db
        .select()
        .from(pinnedMessages)
        .where(
          and(
            eq(pinnedMessages.tenantId, tenantId),
            eq(pinnedMessages.channelId, channelId),
          ),
        )
        .orderBy(desc(pinnedMessages.pinnedAt));
      return rows as PinRow[];
    },
  };
}
