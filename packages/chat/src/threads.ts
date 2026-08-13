// Thread identity for channels. Messages remain platform mail; this
// module owns which thread a message belongs to, auto-opens reply
// threads on first reply, and creates delivery threads for routine
// run deliveries.
//
// Platform mail `MailContent.replyTo` still carries a *channel* id for
// mention fan-out (see codec.ts). Message-id reply correlation is a
// workbench concern here — do not fork Interchange mail to change that.

import { and, eq, asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { channelThreadMessages, channelThreads } from "./schema";

export type ThreadKind = "root" | "reply" | "delivery";

export type ChannelThread = {
  readonly id: string;
  readonly tenantId: string;
  readonly channelId: string;
  readonly kind: ThreadKind;
  readonly parentMessageId: string | null;
  readonly runRef: string | null;
  readonly title: string | null;
  readonly createdAt: Date;
};

export type CreateDeliveryThreadInput = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly runRef: string;
  readonly title?: string;
};

export type OpenReplyThreadInput = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly parentMessageId: string;
  readonly title?: string;
};

export type AssignMessageInput = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly messageId: string;
};

export interface ThreadStore {
  ensureRootThread(tenantId: string, channelId: string): Promise<ChannelThread>;
  createDeliveryThread(
    input: CreateDeliveryThreadInput,
  ): Promise<ChannelThread>;
  openReplyThread(input: OpenReplyThreadInput): Promise<ChannelThread>;
  getThread(
    tenantId: string,
    threadId: string,
  ): Promise<ChannelThread | undefined>;
  listThreads(
    tenantId: string,
    channelId: string,
  ): Promise<readonly ChannelThread[]>;
  assignMessage(input: AssignMessageInput): Promise<void>;
  listMessageIds(
    tenantId: string,
    threadId: string,
  ): Promise<readonly string[]>;
  threadIdForMessage(
    tenantId: string,
    channelId: string,
    messageId: string,
  ): Promise<string | undefined>;
}

function newThreadId(): string {
  return `thr_${crypto.randomUUID().replace(/-/g, "")}`;
}

function asKind(raw: string): ThreadKind {
  if (raw === "root" || raw === "reply" || raw === "delivery") return raw;
  throw new Error(`unknown thread kind: ${raw}`);
}

/**
 * Pure helper: which thread should a newly posted message land in?
 * - explicit threadId wins
 * - inReplyToMessageId opens/uses a reply thread (caller still calls
 *   openReplyThread + assignMessage)
 * - otherwise the root feed
 */
export function resolveTargetThread(args: {
  readonly explicitThreadId?: string;
  readonly inReplyToMessageId?: string;
  readonly rootThreadId: string;
  readonly replyThreadId?: string;
}): { readonly threadId: string; readonly needsReplyOpen: boolean } {
  if (args.explicitThreadId !== undefined) {
    return { threadId: args.explicitThreadId, needsReplyOpen: false };
  }
  if (args.inReplyToMessageId !== undefined) {
    if (args.replyThreadId !== undefined) {
      return { threadId: args.replyThreadId, needsReplyOpen: false };
    }
    return { threadId: args.rootThreadId, needsReplyOpen: true };
  }
  return { threadId: args.rootThreadId, needsReplyOpen: false };
}

export function createInMemoryThreadStore(): ThreadStore {
  const threads = new Map<string, ChannelThread>();
  const byChannel = new Map<string, string[]>();
  const messageToThread = new Map<string, string>();
  const threadMessages = new Map<string, string[]>();

  const channelKey = (tenantId: string, channelId: string) =>
    `${tenantId}::${channelId}`;
  const messageKey = (tenantId: string, channelId: string, messageId: string) =>
    `${tenantId}::${channelId}::${messageId}`;

  return {
    async ensureRootThread(tenantId, channelId) {
      const key = channelKey(tenantId, channelId);
      const ids = byChannel.get(key) ?? [];
      for (const id of ids) {
        const t = threads.get(id);
        if (t?.kind === "root") return t;
      }
      const row: ChannelThread = {
        id: newThreadId(),
        tenantId,
        channelId,
        kind: "root",
        parentMessageId: null,
        runRef: null,
        title: null,
        createdAt: new Date(),
      };
      threads.set(row.id, row);
      byChannel.set(key, [...ids, row.id]);
      return row;
    },

    async createDeliveryThread(input) {
      const key = channelKey(input.tenantId, input.channelId);
      const ids = byChannel.get(key) ?? [];
      for (const id of ids) {
        const t = threads.get(id);
        if (t?.kind === "delivery" && t.runRef === input.runRef) return t;
      }
      const row: ChannelThread = {
        id: newThreadId(),
        tenantId: input.tenantId,
        channelId: input.channelId,
        kind: "delivery",
        parentMessageId: null,
        runRef: input.runRef,
        title: input.title ?? null,
        createdAt: new Date(),
      };
      threads.set(row.id, row);
      byChannel.set(key, [...ids, row.id]);
      return row;
    },

    async openReplyThread(input) {
      const key = channelKey(input.tenantId, input.channelId);
      const ids = byChannel.get(key) ?? [];
      for (const id of ids) {
        const t = threads.get(id);
        if (
          t?.kind === "reply" &&
          t.parentMessageId === input.parentMessageId
        ) {
          return t;
        }
      }
      const row: ChannelThread = {
        id: newThreadId(),
        tenantId: input.tenantId,
        channelId: input.channelId,
        kind: "reply",
        parentMessageId: input.parentMessageId,
        runRef: null,
        title: input.title ?? null,
        createdAt: new Date(),
      };
      threads.set(row.id, row);
      byChannel.set(key, [...ids, row.id]);
      return row;
    },

    async getThread(tenantId, threadId) {
      const t = threads.get(threadId);
      if (t === undefined || t.tenantId !== tenantId) return undefined;
      return t;
    },

    async listThreads(tenantId, channelId) {
      const ids = byChannel.get(channelKey(tenantId, channelId)) ?? [];
      return ids
        .flatMap((id) => {
          const t = threads.get(id);
          return t === undefined ? [] : [t];
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async assignMessage(input) {
      messageToThread.set(
        messageKey(input.tenantId, input.channelId, input.messageId),
        input.threadId,
      );
      const list = threadMessages.get(input.threadId) ?? [];
      if (!list.includes(input.messageId)) {
        threadMessages.set(input.threadId, [...list, input.messageId]);
      }
    },

    async listMessageIds(tenantId, threadId) {
      const t = threads.get(threadId);
      if (t === undefined || t.tenantId !== tenantId) return [];
      return threadMessages.get(threadId) ?? [];
    },

    async threadIdForMessage(tenantId, channelId, messageId) {
      return messageToThread.get(messageKey(tenantId, channelId, messageId));
    },
  };
}

export type ThreadDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

function requireReturningRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${what} row from returning()`);
  }
  return row;
}

function mapThreadRow(row: typeof channelThreads.$inferSelect): ChannelThread {
  return {
    id: row.id,
    tenantId: row.tenantId,
    channelId: row.channelId,
    kind: asKind(row.kind),
    parentMessageId: row.parentMessageId ?? null,
    runRef: row.runRef ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
  };
}

export function createDrizzleThreadStore<
  TSchema extends Record<string, unknown>,
>(db: ThreadDb<TSchema>): ThreadStore {
  return {
    async ensureRootThread(tenantId, channelId) {
      const existing = await db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.tenantId, tenantId),
            eq(channelThreads.channelId, channelId),
            eq(channelThreads.kind, "root"),
          ),
        )
        .limit(1);
      if (existing[0]) return mapThreadRow(existing[0]);
      const id = newThreadId();
      const inserted = await db
        .insert(channelThreads)
        .values({
          id,
          tenantId,
          channelId,
          kind: "root",
          parentMessageId: null,
          runRef: null,
          title: null,
        })
        .returning();
      return mapThreadRow(requireReturningRow(inserted, "root thread"));
    },

    async createDeliveryThread(input) {
      const existing = await db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.tenantId, input.tenantId),
            eq(channelThreads.channelId, input.channelId),
            eq(channelThreads.kind, "delivery"),
            eq(channelThreads.runRef, input.runRef),
          ),
        )
        .limit(1);
      if (existing[0]) return mapThreadRow(existing[0]);
      const id = newThreadId();
      const inserted = await db
        .insert(channelThreads)
        .values({
          id,
          tenantId: input.tenantId,
          channelId: input.channelId,
          kind: "delivery",
          parentMessageId: null,
          runRef: input.runRef,
          title: input.title ?? null,
        })
        .returning();
      return mapThreadRow(requireReturningRow(inserted, "delivery thread"));
    },

    async openReplyThread(input) {
      const existing = await db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.tenantId, input.tenantId),
            eq(channelThreads.channelId, input.channelId),
            eq(channelThreads.kind, "reply"),
            eq(channelThreads.parentMessageId, input.parentMessageId),
          ),
        )
        .limit(1);
      if (existing[0]) return mapThreadRow(existing[0]);
      const id = newThreadId();
      const inserted = await db
        .insert(channelThreads)
        .values({
          id,
          tenantId: input.tenantId,
          channelId: input.channelId,
          kind: "reply",
          parentMessageId: input.parentMessageId,
          runRef: null,
          title: input.title ?? null,
        })
        .returning();
      return mapThreadRow(requireReturningRow(inserted, "reply thread"));
    },

    async getThread(tenantId, threadId) {
      const rows = await db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.tenantId, tenantId),
            eq(channelThreads.id, threadId),
          ),
        )
        .limit(1);
      return rows[0] ? mapThreadRow(rows[0]) : undefined;
    },

    async listThreads(tenantId, channelId) {
      const rows = await db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.tenantId, tenantId),
            eq(channelThreads.channelId, channelId),
          ),
        )
        .orderBy(asc(channelThreads.createdAt));
      return rows.map(mapThreadRow);
    },

    async assignMessage(input) {
      await db
        .insert(channelThreadMessages)
        .values({
          tenantId: input.tenantId,
          channelId: input.channelId,
          threadId: input.threadId,
          messageId: input.messageId,
        })
        .onConflictDoNothing();
    },

    async listMessageIds(tenantId, threadId) {
      const rows = await db
        .select({ messageId: channelThreadMessages.messageId })
        .from(channelThreadMessages)
        .where(
          and(
            eq(channelThreadMessages.tenantId, tenantId),
            eq(channelThreadMessages.threadId, threadId),
          ),
        )
        .orderBy(asc(channelThreadMessages.createdAt));
      return rows.map((r) => r.messageId);
    },

    async threadIdForMessage(tenantId, channelId, messageId) {
      const rows = await db
        .select({ threadId: channelThreadMessages.threadId })
        .from(channelThreadMessages)
        .where(
          and(
            eq(channelThreadMessages.tenantId, tenantId),
            eq(channelThreadMessages.channelId, channelId),
            eq(channelThreadMessages.messageId, messageId),
          ),
        )
        .limit(1);
      return rows[0]?.threadId;
    },
  };
}

/**
 * Contract routines delivery uses: create (or reuse) a delivery thread
 * for a run in a channel, then the launcher posts into that thread.
 */
export async function createDeliveryThread(
  store: ThreadStore,
  input: CreateDeliveryThreadInput,
): Promise<ChannelThread> {
  await store.ensureRootThread(input.tenantId, input.channelId);
  return store.createDeliveryThread(input);
}
