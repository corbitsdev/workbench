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

/**
 * Two levels, stop: channel → thread → sub-thread, no unbounded
 * nesting (owner ruling, CL-5908). `parentThreadId` is the thread this
 * one hangs directly off — null for the root thread, the root
 * thread's id for a depth-1 thread, and a depth-1 thread's id for a
 * depth-2 sub-thread. A depth-2 thread's id never appears as another
 * thread's `parentThreadId` — see `resolveThreadAnchor`.
 */
export type ChannelThread = {
  readonly id: string;
  readonly tenantId: string;
  readonly channelId: string;
  readonly kind: ThreadKind;
  readonly parentMessageId: string | null;
  readonly parentThreadId: string | null;
  readonly runRef: string | null;
  readonly title: string | null;
  readonly createdAt: Date;
};

/** A reply/fork would nest a thread past the two-level cap. */
export class ThreadDepthCapError extends Error {
  constructor() {
    super("thread nesting is capped at two levels (thread → sub-thread)");
    this.name = "ThreadDepthCapError";
  }
}

export type ThreadAnchor = {
  /** Which thread the new reply/fork thread should hang off. */
  readonly parentThreadId: string;
  /**
   * True when `container` is already a depth-2 sub-thread, so hanging
   * a new thread directly off it would be a third level. A capped
   * reply-open must refuse (see `openReplyThread`); an explicit fork
   * instead redirects to `parentThreadId` — a sibling sub-thread under
   * the same depth-1 parent, never a third level (CL-5948).
   */
  readonly blocked: boolean;
};

/**
 * Where a new thread anchored on a message inside `container` belongs.
 * `container` is the thread the origin message currently lives in (the
 * root thread if the message isn't assigned to any thread yet).
 */
export function resolveThreadAnchor(
  root: ChannelThread,
  container: ChannelThread,
): ThreadAnchor {
  if (container.id === root.id) {
    return { parentThreadId: root.id, blocked: false };
  }
  if (
    container.parentThreadId === null ||
    container.parentThreadId === root.id
  ) {
    return { parentThreadId: container.id, blocked: false };
  }
  return { parentThreadId: container.parentThreadId, blocked: true };
}

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

/** Same shape as opening a reply thread — a fork is anchored the same
 * way, just explicitly user-initiated and depth-cap-redirecting rather
 * than depth-cap-refusing. See `resolveThreadAnchor`. */
export type ForkThreadInput = OpenReplyThreadInput;

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
  /** Opens (or reuses) the depth-1 reply thread for a message. Throws
   * `ThreadDepthCapError` if the message already lives in a depth-2
   * sub-thread — a caller wanting the depth-cap-redirect behavior wants
   * `forkThread`, not this. */
  openReplyThread(input: OpenReplyThreadInput): Promise<ChannelThread>;
  /** Opens (or reuses) a sub-thread rooted at a message, honoring the
   * two-level cap: forking from a message already inside a sub-thread
   * creates a sibling sub-thread under that sub-thread's parent rather
   * than a third level (CL-5948). Never throws for depth. */
  forkThread(input: ForkThreadInput): Promise<ChannelThread>;
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
  /**
   * Every membership row this channel has, as `messageId -> threadId`.
   * A message with no row is absent rather than defaulted to the root
   * thread: the "root feed by default" contract belongs to whoever
   * reads a thread's messages (see the threads route in `./routes.ts`),
   * so this stays a faithful report of what was actually written.
   */
  listThreadAssignments(
    tenantId: string,
    channelId: string,
  ): Promise<ReadonlyMap<string, string>>;
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

  async function ensureRootThread(
    tenantId: string,
    channelId: string,
  ): Promise<ChannelThread> {
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
      parentThreadId: null,
      runRef: null,
      title: null,
      createdAt: new Date(),
    };
    threads.set(row.id, row);
    byChannel.set(key, [...ids, row.id]);
    return row;
  }

  /** The thread a message currently lives in, or `root` if unassigned. */
  async function containerThreadFor(
    tenantId: string,
    channelId: string,
    parentMessageId: string,
    root: ChannelThread,
  ): Promise<ChannelThread> {
    const containerId = messageToThread.get(
      messageKey(tenantId, channelId, parentMessageId),
    );
    if (containerId === undefined) return root;
    return threads.get(containerId) ?? root;
  }

  async function anchoredReplyThread(
    input: OpenReplyThreadInput,
    mode: "reply" | "fork",
  ): Promise<ChannelThread> {
    const key = channelKey(input.tenantId, input.channelId);
    const root = await ensureRootThread(input.tenantId, input.channelId);
    const ids = byChannel.get(key) ?? [];
    for (const id of ids) {
      const t = threads.get(id);
      if (t?.kind === "reply" && t.parentMessageId === input.parentMessageId) {
        return t;
      }
    }
    const container = await containerThreadFor(
      input.tenantId,
      input.channelId,
      input.parentMessageId,
      root,
    );
    const anchor = resolveThreadAnchor(root, container);
    if (anchor.blocked && mode === "reply") throw new ThreadDepthCapError();
    const row: ChannelThread = {
      id: newThreadId(),
      tenantId: input.tenantId,
      channelId: input.channelId,
      kind: "reply",
      parentMessageId: input.parentMessageId,
      parentThreadId: anchor.parentThreadId,
      runRef: null,
      title: input.title ?? null,
      createdAt: new Date(),
    };
    threads.set(row.id, row);
    byChannel.set(key, [...ids, row.id]);
    return row;
  }

  return {
    ensureRootThread,

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
        parentThreadId: null,
        runRef: input.runRef,
        title: input.title ?? null,
        createdAt: new Date(),
      };
      threads.set(row.id, row);
      byChannel.set(key, [...ids, row.id]);
      return row;
    },

    openReplyThread: (input) => anchoredReplyThread(input, "reply"),
    forkThread: (input) => anchoredReplyThread(input, "fork"),

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

    async listThreadAssignments(tenantId, channelId) {
      const prefix = `${channelKey(tenantId, channelId)}::`;
      const assignments = new Map<string, string>();
      for (const [key, threadId] of messageToThread) {
        if (!key.startsWith(prefix)) continue;
        assignments.set(key.slice(prefix.length), threadId);
      }
      return assignments;
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
    parentThreadId: row.parentThreadId ?? null,
    runRef: row.runRef ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
  };
}

export function createDrizzleThreadStore<
  TSchema extends Record<string, unknown>,
>(db: ThreadDb<TSchema>): ThreadStore {
  async function ensureRootThread(
    tenantId: string,
    channelId: string,
  ): Promise<ChannelThread> {
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
        parentThreadId: null,
        runRef: null,
        title: null,
      })
      .returning();
    return mapThreadRow(requireReturningRow(inserted, "root thread"));
  }

  /** The thread a message currently lives in, or `root` if unassigned. */
  async function containerThreadFor(
    tenantId: string,
    channelId: string,
    parentMessageId: string,
    root: ChannelThread,
  ): Promise<ChannelThread> {
    const rows = await db
      .select({ threadId: channelThreadMessages.threadId })
      .from(channelThreadMessages)
      .where(
        and(
          eq(channelThreadMessages.tenantId, tenantId),
          eq(channelThreadMessages.channelId, channelId),
          eq(channelThreadMessages.messageId, parentMessageId),
        ),
      )
      .limit(1);
    const containerId = rows[0]?.threadId;
    if (containerId === undefined) return root;
    const containerRows = await db
      .select()
      .from(channelThreads)
      .where(
        and(
          eq(channelThreads.tenantId, tenantId),
          eq(channelThreads.id, containerId),
        ),
      )
      .limit(1);
    return containerRows[0] ? mapThreadRow(containerRows[0]) : root;
  }

  async function anchoredReplyThread(
    input: OpenReplyThreadInput,
    mode: "reply" | "fork",
  ): Promise<ChannelThread> {
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
    const root = await ensureRootThread(input.tenantId, input.channelId);
    const container = await containerThreadFor(
      input.tenantId,
      input.channelId,
      input.parentMessageId,
      root,
    );
    const anchor = resolveThreadAnchor(root, container);
    if (anchor.blocked && mode === "reply") throw new ThreadDepthCapError();
    const id = newThreadId();
    const inserted = await db
      .insert(channelThreads)
      .values({
        id,
        tenantId: input.tenantId,
        channelId: input.channelId,
        kind: "reply",
        parentMessageId: input.parentMessageId,
        parentThreadId: anchor.parentThreadId,
        runRef: null,
        title: input.title ?? null,
      })
      .returning();
    return mapThreadRow(requireReturningRow(inserted, `${mode} thread`));
  }

  return {
    ensureRootThread,

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
          parentThreadId: null,
          runRef: input.runRef,
          title: input.title ?? null,
        })
        .returning();
      return mapThreadRow(requireReturningRow(inserted, "delivery thread"));
    },

    openReplyThread: (input) => anchoredReplyThread(input, "reply"),
    forkThread: (input) => anchoredReplyThread(input, "fork"),

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

    async listThreadAssignments(tenantId, channelId) {
      const rows = await db
        .select({
          messageId: channelThreadMessages.messageId,
          threadId: channelThreadMessages.threadId,
        })
        .from(channelThreadMessages)
        .where(
          and(
            eq(channelThreadMessages.tenantId, tenantId),
            eq(channelThreadMessages.channelId, channelId),
          ),
        );
      return new Map(rows.map((row) => [row.messageId, row.threadId]));
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
