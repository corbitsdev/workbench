// Persistence and pure aggregation for poll/form block round-trips.
// `blockId` is the agent-authored `pollId`/`formId` off `PollBlockData`/
// `FormBlockData` — never trusted as a globally unique key on its own, since
// two different agents (or the same agent twice) can pick the same string
// in two different messages. Every row here is additionally scoped by
// `messageId`, so a response can only ever collide with another response to
// the *same* block in the *same* message; it can never be hijacked into, or
// tallied against, an unrelated message that happens to reuse the id.
//
// One row per (tenant, channel, message, block, principal): a second
// response from the same principal to the same block overwrites the first
// — "upsert = change vote" for polls, "upsert = resubmit" for forms.

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { blockResponses } from "./schema";

export type BlockResponsePayload =
  | { readonly kind: "poll"; readonly choiceIds: readonly string[] }
  | {
      readonly kind: "form";
      readonly values: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "question";
      readonly answer: string;
      readonly optionIndex?: number;
    };

export interface BlockResponseRow {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly blockId: string;
  readonly principalId: string;
  readonly payload: BlockResponsePayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertBlockResponseInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly blockId: string;
  readonly principalId: string;
  readonly payload: BlockResponsePayload;
}

export interface BlockResponseStore {
  upsertBlockResponse(
    input: UpsertBlockResponseInput,
  ): Promise<BlockResponseRow>;
  /**
   * Every response on file for one block instance — including every other
   * principal's raw payload. Only ever called from inside a route handler
   * that filters this down before it reaches the wire (aggregate tallies
   * for a poll, the caller's own row only for a form): never exposed to a
   * client directly.
   */
  listBlockResponses(
    tenantId: string,
    channelId: string,
    messageId: string,
    blockId: string,
  ): Promise<readonly BlockResponseRow[]>;
}

export interface BlockResponseAggregation {
  readonly tally: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * Vote tallies for a poll, computed fresh from stored responses on every
 * read — never from anything agent-authored. Non-poll rows (a block that
 * somehow carries a mismatched payload kind) are ignored rather than
 * corrupting the count.
 */
export function aggregatePollResponses(
  rows: readonly BlockResponseRow[],
): BlockResponseAggregation {
  const tally: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (row.payload.kind !== "poll") continue;
    total += 1;
    for (const choiceId of row.payload.choiceIds) {
      tally[choiceId] = (tally[choiceId] ?? 0) + 1;
    }
  }
  return { tally, total };
}

function responseKey(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
  principalId: string,
): string {
  return `${tenantId}::${channelId}::${messageId}::${blockId}::${principalId}`;
}

function blockKey(
  tenantId: string,
  channelId: string,
  messageId: string,
  blockId: string,
): string {
  return `${tenantId}::${channelId}::${messageId}::${blockId}`;
}

export function createInMemoryBlockResponseStore(): BlockResponseStore {
  const rows = new Map<string, BlockResponseRow>();
  const byBlock = new Map<string, Set<string>>();

  return {
    async upsertBlockResponse(input) {
      const key = responseKey(
        input.tenantId,
        input.channelId,
        input.messageId,
        input.blockId,
        input.principalId,
      );
      const existing = rows.get(key);
      const now = new Date();
      const row: BlockResponseRow = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        messageId: input.messageId,
        blockId: input.blockId,
        principalId: input.principalId,
        payload: input.payload,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(key, row);
      const blk = blockKey(
        input.tenantId,
        input.channelId,
        input.messageId,
        input.blockId,
      );
      const keys = byBlock.get(blk) ?? new Set<string>();
      keys.add(key);
      byBlock.set(blk, keys);
      return row;
    },

    async listBlockResponses(tenantId, channelId, messageId, blockId) {
      const keys = byBlock.get(
        blockKey(tenantId, channelId, messageId, blockId),
      );
      if (keys === undefined) return [];
      return [...keys].flatMap((key) => {
        const row = rows.get(key);
        return row === undefined ? [] : [row];
      });
    },
  };
}

export type BlockResponseDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

function mapRow(row: typeof blockResponses.$inferSelect): BlockResponseRow {
  return {
    tenantId: row.tenantId,
    channelId: row.channelId,
    messageId: row.messageId,
    blockId: row.blockId,
    principalId: row.principalId,
    payload: row.payload as BlockResponsePayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleBlockResponseStore<
  TSchema extends Record<string, unknown>,
>(db: BlockResponseDb<TSchema>): BlockResponseStore {
  return {
    async upsertBlockResponse(input) {
      const now = new Date();
      const [row] = await db
        .insert(blockResponses)
        .values({
          tenantId: input.tenantId,
          channelId: input.channelId,
          messageId: input.messageId,
          blockId: input.blockId,
          principalId: input.principalId,
          payload: input.payload,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            blockResponses.tenantId,
            blockResponses.channelId,
            blockResponses.messageId,
            blockResponses.blockId,
            blockResponses.principalId,
          ],
          set: { payload: input.payload, updatedAt: now },
        })
        .returning();
      if (row === undefined) {
        throw new Error("upsertBlockResponse: insert returned no row");
      }
      return mapRow(row);
    },

    async listBlockResponses(tenantId, channelId, messageId, blockId) {
      const rows = await db
        .select()
        .from(blockResponses)
        .where(
          and(
            eq(blockResponses.tenantId, tenantId),
            eq(blockResponses.channelId, channelId),
            eq(blockResponses.messageId, messageId),
            eq(blockResponses.blockId, blockId),
          ),
        );
      return rows.map(mapRow);
    },
  };
}
