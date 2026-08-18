// Persistence for the client-generated send identity a composer submit
// carries (CL-6251). One row per message, written once `POST
// .../messages` has a real `messageId` from `sendWorkbenchMessage` — the
// same "row's existence is the fact" shape `./pins.ts` and
// `./reactions.ts` follow, here recording which `clientId` a message
// was sent under rather than whether it was pinned/reacted-to.
//
// This is what lets the sender's own pending (optimistic) bubble
// reconcile with the confirmed message by identity instead of by
// guessing from content/timing: `GET /workbenches/:id/messages` folds
// `clientId` onto every item the same way `enrichWithReactionsAndPins`
// folds `reactions`/`pinned`, so whichever arrives first for a given
// send — the POST response's own echo, or the next message-list
// load — carries the same `clientId` the pending bubble was keyed by,
// and the other arrival is a no-op.

import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { messageClientIds } from "./schema";

export interface ClientIdRow {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly messageId: string;
  readonly clientId: string;
}

export interface RecordClientIdInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly messageId: string;
  readonly clientId: string;
}

export interface ClientIdStore {
  recordClientId(input: RecordClientIdInput): Promise<void>;
  /**
   * Every recorded `clientId` across the given message ids, in one
   * query — the batched read `GET /workbenches/:id/messages` calls once
   * per page rather than once per message. An empty `messageIds`
   * short-circuits to `[]` without touching the store at all.
   */
  listClientIdsForMessages(
    tenantId: string,
    workbenchId: string,
    messageIds: readonly string[],
  ): Promise<readonly ClientIdRow[]>;
}

function clientIdKey(
  tenantId: string,
  workbenchId: string,
  messageId: string,
): string {
  return `${tenantId}::${workbenchId}::${messageId}`;
}

export function createInMemoryClientIdStore(): ClientIdStore {
  const rows = new Map<string, ClientIdRow>();

  return {
    async recordClientId(input) {
      rows.set(
        clientIdKey(input.tenantId, input.workbenchId, input.messageId),
        {
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          messageId: input.messageId,
          clientId: input.clientId,
        },
      );
    },

    async listClientIdsForMessages(tenantId, workbenchId, messageIds) {
      if (messageIds.length === 0) return [];
      const wanted = new Set(messageIds);
      return [...rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          row.workbenchId === workbenchId &&
          wanted.has(row.messageId),
      );
    },
  };
}

export type ClientIdDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export function createDrizzleClientIdStore<
  TSchema extends Record<string, unknown>,
>(db: ClientIdDb<TSchema>): ClientIdStore {
  return {
    async recordClientId(input) {
      await db
        .insert(messageClientIds)
        .values({
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          messageId: input.messageId,
          clientId: input.clientId,
        })
        .onConflictDoNothing({
          target: [
            messageClientIds.tenantId,
            messageClientIds.workbenchId,
            messageClientIds.messageId,
          ],
        });
    },

    async listClientIdsForMessages(tenantId, workbenchId, messageIds) {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select({
          tenantId: messageClientIds.tenantId,
          workbenchId: messageClientIds.workbenchId,
          messageId: messageClientIds.messageId,
          clientId: messageClientIds.clientId,
        })
        .from(messageClientIds)
        .where(
          and(
            eq(messageClientIds.tenantId, tenantId),
            eq(messageClientIds.workbenchId, workbenchId),
            inArray(messageClientIds.messageId, messageIds),
          ),
        );
      return rows;
    },
  };
}
