// Chat-owned rich-part sidecar for timeline rows that live as native
// @corbits/mailbox frames (CL-7594). One row per frame, keyed by the
// frame's own RFC 5322 Message-ID, carrying the `Part[]` payload the
// room UI's blocks render from — the same "row's existence is the fact"
// presence-as-truth shape `./client-ids.ts`, `./pins.ts`, and
// `./reactions.ts` follow. The mailbox owns the frame and knows nothing
// of this table; a frame with no sidecar row renders its text-only
// fallback, never an error.

import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { type Part, parsePart } from "./parts";
import { messageParts } from "./schema";

export interface MessagePartsRow {
  readonly tenantId: string;
  readonly mailMessageId: string;
  readonly workbenchId: string;
  readonly parts: readonly Part[];
}

export interface RecordMessagePartsInput {
  readonly tenantId: string;
  readonly mailMessageId: string;
  readonly workbenchId: string;
  readonly parts: readonly Part[];
}

export interface MessagePartsStore {
  recordMessageParts(input: RecordMessagePartsInput): Promise<void>;
  /**
   * The confirmed `Part[]` for one frame, or null when no sidecar row
   * exists (or its payload no longer parses — a corrupt row renders the
   * fallback, it never breaks the timeline).
   */
  readMessageParts(
    tenantId: string,
    mailMessageId: string,
  ): Promise<readonly Part[] | null>;
  /**
   * Every sidecar row across the given Message-IDs, in one query — the
   * batched read the room timeline calls once per page rather than once
   * per frame. An empty `mailMessageIds` short-circuits to `[]` without
   * touching the store at all.
   */
  listMessagePartsForFrames(
    tenantId: string,
    mailMessageIds: readonly string[],
  ): Promise<readonly MessagePartsRow[]>;
}

function parseStoredParts(data: unknown): readonly Part[] | null {
  if (!Array.isArray(data)) return null;
  try {
    return data.map((entry) => parsePart(entry));
  } catch {
    return null;
  }
}

export function createInMemoryMessagePartsStore(): MessagePartsStore {
  const rows = new Map<string, MessagePartsRow>();

  return {
    async recordMessageParts(input) {
      rows.set(`${input.tenantId}::${input.mailMessageId}`, {
        tenantId: input.tenantId,
        mailMessageId: input.mailMessageId,
        workbenchId: input.workbenchId,
        parts: [...input.parts],
      });
    },

    async readMessageParts(tenantId, mailMessageId) {
      const row = rows.get(`${tenantId}::${mailMessageId}`);
      return row ? row.parts : null;
    },

    async listMessagePartsForFrames(tenantId, mailMessageIds) {
      if (mailMessageIds.length === 0) return [];
      const wanted = new Set(mailMessageIds);
      return [...rows.values()].filter(
        (row) => row.tenantId === tenantId && wanted.has(row.mailMessageId),
      );
    },
  };
}

export type MessagePartsDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export function createDrizzleMessagePartsStore<
  TSchema extends Record<string, unknown>,
>(db: MessagePartsDb<TSchema>): MessagePartsStore {
  return {
    async recordMessageParts(input) {
      await db
        .insert(messageParts)
        .values({
          tenantId: input.tenantId,
          mailMessageId: input.mailMessageId,
          workbenchId: input.workbenchId,
          parts: [...input.parts],
        })
        .onConflictDoNothing({
          target: [messageParts.tenantId, messageParts.mailMessageId],
        });
    },

    async readMessageParts(tenantId, mailMessageId) {
      const rows = await db
        .select({ parts: messageParts.parts })
        .from(messageParts)
        .where(
          and(
            eq(messageParts.tenantId, tenantId),
            eq(messageParts.mailMessageId, mailMessageId),
          ),
        )
        .limit(1);
      if (rows.length === 0) return null;
      return parseStoredParts(rows[0].parts);
    },

    async listMessagePartsForFrames(tenantId, mailMessageIds) {
      if (mailMessageIds.length === 0) return [];
      const rows = await db
        .select({
          tenantId: messageParts.tenantId,
          mailMessageId: messageParts.mailMessageId,
          workbenchId: messageParts.workbenchId,
          parts: messageParts.parts,
        })
        .from(messageParts)
        .where(
          and(
            eq(messageParts.tenantId, tenantId),
            inArray(messageParts.mailMessageId, mailMessageIds),
          ),
        );
      const parsed: MessagePartsRow[] = [];
      for (const row of rows) {
        const parts = parseStoredParts(row.parts);
        if (parts === null) continue;
        parsed.push({ ...row, parts });
      }
      return parsed;
    },
  };
}
