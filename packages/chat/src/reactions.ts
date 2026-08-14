// Persistence and pure aggregation for message reactions. One row per
// (tenant, channel, message, emoji, principal) — see `./schema.ts`'s
// `messageReactions` for why presence of the row *is* the reaction,
// with no separate count column to drift out of sync. `toggleReaction`
// is the only write: a principal who hasn't reacted with this emoji on
// this message gets a row inserted, a principal who has gets it
// deleted — true toggle semantics, mirroring the on/off affordance the
// UI's reaction chip offers.
//
// `listReactionsForMessages` is the one read `routes.ts` calls, batched
// over every message id in the page it's enriching — a single query
// covering the whole visible window rather than one round trip per
// message.

import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { messageReactions } from "./schema";

export interface ReactionRow {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
  readonly principalId: string;
  readonly createdAt: Date;
}

export interface ToggleReactionInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
  readonly principalId: string;
}

export interface ToggleReactionResult {
  /** `true` when the toggle added the reaction, `false` when it removed
   * an existing one. */
  readonly added: boolean;
}

export interface ReactionStore {
  toggleReaction(input: ToggleReactionInput): Promise<ToggleReactionResult>;
  /**
   * Every reaction row across the given message ids, in one query — the
   * batched read `GET /channels/:id/messages` calls once per page
   * rather than once per message. An empty `messageIds` short-circuits
   * to `[]` without touching the store at all.
   */
  listReactionsForMessages(
    tenantId: string,
    channelId: string,
    messageIds: readonly string[],
  ): Promise<readonly ReactionRow[]>;
}

export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  readonly reactedByMe: boolean;
}

/**
 * Folds every reaction row for one message into the per-emoji summary
 * the wire (and the reaction chip row) actually renders: a count and
 * whether the given principal is among the reactors. Emoji with zero
 * rows never appear — there is nothing to render a chip for.
 */
export function aggregateReactions(
  rows: readonly ReactionRow[],
  principalId: string,
): readonly ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const row of rows) {
    const existing = byEmoji.get(row.emoji) ?? { count: 0, reactedByMe: false };
    byEmoji.set(row.emoji, {
      count: existing.count + 1,
      reactedByMe: existing.reactedByMe || row.principalId === principalId,
    });
  }
  return [...byEmoji.entries()].map(([emoji, summary]) => ({
    emoji,
    ...summary,
  }));
}

/**
 * Groups a batched `listReactionsForMessages` read by `messageId`, each
 * already folded through `aggregateReactions` — the shape `routes.ts`
 * needs to attach a `reactions` field onto every item of a message
 * page in one pass.
 */
export function aggregateReactionsByMessage(
  rows: readonly ReactionRow[],
  principalId: string,
): ReadonlyMap<string, readonly ReactionSummary[]> {
  const byMessage = new Map<string, ReactionRow[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row);
    byMessage.set(row.messageId, list);
  }
  return new Map(
    [...byMessage.entries()].map(([messageId, messageRows]) => [
      messageId,
      aggregateReactions(messageRows, principalId),
    ]),
  );
}

function reactionKey(input: {
  tenantId: string;
  channelId: string;
  messageId: string;
  emoji: string;
  principalId: string;
}): string {
  return [
    input.tenantId,
    input.channelId,
    input.messageId,
    input.emoji,
    input.principalId,
  ].join("::");
}

export function createInMemoryReactionStore(): ReactionStore {
  const rows = new Map<string, ReactionRow>();

  return {
    async toggleReaction(input) {
      const key = reactionKey(input);
      if (rows.has(key)) {
        rows.delete(key);
        return { added: false };
      }
      rows.set(key, { ...input, createdAt: new Date() });
      return { added: true };
    },

    async listReactionsForMessages(tenantId, channelId, messageIds) {
      if (messageIds.length === 0) return [];
      const wanted = new Set(messageIds);
      return [...rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          row.channelId === channelId &&
          wanted.has(row.messageId),
      );
    },
  };
}

export type ReactionDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export function createDrizzleReactionStore<
  TSchema extends Record<string, unknown>,
>(db: ReactionDb<TSchema>): ReactionStore {
  return {
    async toggleReaction(input) {
      const existing = await db
        .select({ principalId: messageReactions.principalId })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.tenantId, input.tenantId),
            eq(messageReactions.channelId, input.channelId),
            eq(messageReactions.messageId, input.messageId),
            eq(messageReactions.emoji, input.emoji),
            eq(messageReactions.principalId, input.principalId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .delete(messageReactions)
          .where(
            and(
              eq(messageReactions.tenantId, input.tenantId),
              eq(messageReactions.channelId, input.channelId),
              eq(messageReactions.messageId, input.messageId),
              eq(messageReactions.emoji, input.emoji),
              eq(messageReactions.principalId, input.principalId),
            ),
          );
        return { added: false };
      }

      await db.insert(messageReactions).values({
        tenantId: input.tenantId,
        channelId: input.channelId,
        messageId: input.messageId,
        emoji: input.emoji,
        principalId: input.principalId,
      });
      return { added: true };
    },

    async listReactionsForMessages(tenantId, channelId, messageIds) {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select()
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.tenantId, tenantId),
            eq(messageReactions.channelId, channelId),
            inArray(messageReactions.messageId, messageIds),
          ),
        );
      return rows as ReactionRow[];
    },
  };
}
