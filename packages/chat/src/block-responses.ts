// Persistence and pure aggregation for poll/form/question block round-trips.
// `blockId` is the agent-authored `pollId`/`formId`/`questionId` off
// `PollBlockData`/`FormBlockData`/`QuestionBlockData` — never trusted as a
// globally unique key on its own, since two different agents (or the same
// agent twice) can pick the same string in two different messages. Every row
// here is additionally scoped by `messageId`, so a response can only ever
// collide with another response to the *same* block in the *same* message;
// it can never be hijacked into, or tallied against, an unrelated message
// that happens to reuse the id.
//
// One row per (tenant, workbench, message, block, principal): a second
// response from the same principal to the same block overwrites the first
// — "upsert = change vote" for polls, "upsert = resubmit" for forms,
// "upsert = re-answer" for questions.
//
// `notifiedAt` is a question-only claim flag, null until a question's
// answer has been sent into the workbench and dispatched to the asking
// agent. `claimBlockResponseNotification` flips it (and stamps a fresh
// `notificationClaimToken`) in one guarded UPDATE so concurrent submissions
// for the same (message, block, principal) — a changed answer, or a
// double-click that beats the UI's disable — can never both win the claim:
// exactly one caller ever sees itself as responsible for sending the
// notification (see CL-7192). `releaseBlockResponseNotification` is the
// failure path's undo, and only ever succeeds when the token it is given
// still matches the row's current claim — the same token-scoping
// `turn-claims.ts` uses (CL-7129) so a caller can never release a claim it
// does not hold. `write-claims.ts`'s release is unconditional instead, but
// only because nothing there can ever reassign a claim out from under its
// holder; this store has no TTL or reaper either, so today no caller could
// actually present a stale token — the scoping is cheap insurance against a
// future release call site (a sweep, an admin action) rather than a
// reachable bug today.

import { and, eq, isNull } from "drizzle-orm";
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
  readonly workbenchId: string;
  readonly messageId: string;
  readonly blockId: string;
  readonly principalId: string;
  readonly payload: BlockResponsePayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly notifiedAt: Date | null;
}

export interface BlockResponseKey {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly messageId: string;
  readonly blockId: string;
  readonly principalId: string;
}

export interface UpsertBlockResponseInput extends BlockResponseKey {
  readonly payload: BlockResponsePayload;
}

export interface BlockResponseStore {
  upsertBlockResponse(
    input: UpsertBlockResponseInput,
  ): Promise<BlockResponseRow>;
  /**
   * Atomically claims the right to send a question's answer into the
   * workbench and dispatch the asking agent's turn: flips `notifiedAt`
   * from null to now and returns a fresh token, but only when it was
   * still null. Returns `false` when some other call already holds the
   * claim — the caller must then skip the send entirely rather than risk
   * a second dispatch. The token must be presented back to
   * `releaseBlockResponseNotification` to release this exact claim.
   */
  claimBlockResponseNotification(
    key: BlockResponseKey,
  ): Promise<string | false>;
  /**
   * Releases a claim this call took but failed to act on (the send
   * threw), resetting `notifiedAt` to null so a retried submission can
   * claim it again. A no-op unless `token` is still the current holder —
   * a caller can never release a claim it does not hold. Never called
   * after a successful send.
   */
  releaseBlockResponseNotification(
    key: BlockResponseKey,
    token: string,
  ): Promise<void>;
  /**
   * Every response on file for one block instance — including every other
   * principal's raw payload. Only ever called from inside a route handler
   * that filters this down before it reaches the wire (aggregate tallies
   * for a poll, the caller's own row only for a form): never exposed to a
   * client directly.
   */
  listBlockResponses(
    tenantId: string,
    workbenchId: string,
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

function responseKey(key: BlockResponseKey): string {
  return `${key.tenantId}::${key.workbenchId}::${key.messageId}::${key.blockId}::${key.principalId}`;
}

function blockKey(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
): string {
  return `${tenantId}::${workbenchId}::${messageId}::${blockId}`;
}

export function createInMemoryBlockResponseStore(): BlockResponseStore {
  const rows = new Map<string, BlockResponseRow>();
  const byBlock = new Map<string, Set<string>>();
  const claimTokens = new Map<string, string>();

  return {
    async upsertBlockResponse(input) {
      const key = responseKey(input);
      const existing = rows.get(key);
      const now = new Date();
      const row: BlockResponseRow = {
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        messageId: input.messageId,
        blockId: input.blockId,
        principalId: input.principalId,
        payload: input.payload,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        notifiedAt: existing?.notifiedAt ?? null,
      };
      rows.set(key, row);
      const blk = blockKey(
        input.tenantId,
        input.workbenchId,
        input.messageId,
        input.blockId,
      );
      const keys = byBlock.get(blk) ?? new Set<string>();
      keys.add(key);
      byBlock.set(blk, keys);
      return row;
    },

    async claimBlockResponseNotification(key) {
      const k = responseKey(key);
      const row = rows.get(k);
      if (row === undefined || row.notifiedAt !== null) return false;
      const token = crypto.randomUUID();
      claimTokens.set(k, token);
      rows.set(k, { ...row, notifiedAt: new Date() });
      return token;
    },

    async releaseBlockResponseNotification(key, token) {
      const k = responseKey(key);
      if (claimTokens.get(k) !== token) return;
      claimTokens.delete(k);
      const row = rows.get(k);
      if (row === undefined) return;
      rows.set(k, { ...row, notifiedAt: null });
    },

    async listBlockResponses(tenantId, workbenchId, messageId, blockId) {
      const keys = byBlock.get(
        blockKey(tenantId, workbenchId, messageId, blockId),
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
    workbenchId: row.workbenchId,
    messageId: row.messageId,
    blockId: row.blockId,
    principalId: row.principalId,
    payload: row.payload as BlockResponsePayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    notifiedAt: row.notifiedAt,
  };
}

function keyClause(key: BlockResponseKey) {
  return and(
    eq(blockResponses.tenantId, key.tenantId),
    eq(blockResponses.workbenchId, key.workbenchId),
    eq(blockResponses.messageId, key.messageId),
    eq(blockResponses.blockId, key.blockId),
    eq(blockResponses.principalId, key.principalId),
  );
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
          workbenchId: input.workbenchId,
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
            blockResponses.workbenchId,
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

    async claimBlockResponseNotification(key) {
      const token = crypto.randomUUID();
      const claimed = await db
        .update(blockResponses)
        .set({ notifiedAt: new Date(), notificationClaimToken: token })
        .where(and(keyClause(key), isNull(blockResponses.notifiedAt)))
        .returning({ tenantId: blockResponses.tenantId });
      return claimed.length > 0 ? token : false;
    },

    async releaseBlockResponseNotification(key, token) {
      await db
        .update(blockResponses)
        .set({ notifiedAt: null, notificationClaimToken: null })
        .where(
          and(keyClause(key), eq(blockResponses.notificationClaimToken, token)),
        );
    },

    async listBlockResponses(tenantId, workbenchId, messageId, blockId) {
      const rows = await db
        .select()
        .from(blockResponses)
        .where(
          and(
            eq(blockResponses.tenantId, tenantId),
            eq(blockResponses.workbenchId, workbenchId),
            eq(blockResponses.messageId, messageId),
            eq(blockResponses.blockId, blockId),
          ),
        );
      return rows.map(mapRow);
    },
  };
}
