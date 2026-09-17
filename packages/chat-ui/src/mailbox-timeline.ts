// Pure adapter from a mailbox thread read onto the timeline item shape
// `use-workbench-feed.ts` already produces (CL-8174 slice 2a/2b). No new wire
// shape: a mail message becomes exactly the `MessageItem` the rest of
// chat-ui already knows how to render, so the timeline never has to branch
// on where a message came from.
//
// This file makes its own `fetch()` calls against the mailbox's `/me/threads`
// routes and validates responses with local arktype schemas, rather than
// importing `@corbits/inbox/client` — that client's package re-exports pull
// in `@corbits/mailbox`'s server-only `migrations.ts` (a `node:crypto` user)
// at the value level, which a real bundler (Vite/Rollup) walks into even
// though only types are used, breaking the browser build. Per the owner
// ruling that `@corbits/mailbox` is a temporary, shrinking surface, every
// mailbox read in chat-ui goes through this one file, so swapping to
// Interchange's native mailbox thread shape later is a one-file change.

import { type } from "arktype";
import type { MessageItem, WorkbenchThreadRow } from "./api";

/** A mailbox ref, mirrored locally rather than imported from
 * `@corbits/mailbox` (see the file header) — kept to exactly the shape this
 * file stamps and sends. */
export interface MailboxRef {
  readonly kind: string;
  readonly id: string;
}

export class MailboxThreadFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MailboxThreadFetchError";
  }
}

const MailboxThreadSummary = type({
  rootId: "string",
  rootMessageId: "string",
  "subject?": "string | null",
  messageCount: "number",
  unreadCount: "number",
  lastMessageId: "string",
  lastFromAddress: "string",
  lastCreatedAt: "string",
});

const MailboxThreadListResponse = type({
  threads: MailboxThreadSummary.array(),
  "nextCursor?": "string",
});

const MailboxThreadMessageSchema = type({
  id: "string",
  messageId: "string",
  "inReplyTo?": "string",
  references: "string[]",
  fromAddress: "string",
  "subject?": "string | null",
  createdAt: "string",
  read: "boolean",
  archived: "boolean",
  "parentId?": "string | null",
  body: "string",
});

export type MailboxThreadMessage = typeof MailboxThreadMessageSchema.infer;

const MailboxThreadReadResponse = type({
  messages: MailboxThreadMessageSchema.array(),
  "nextCursor?": "string",
});

async function mailboxRequest<T>(
  path: string,
  schema: (input: unknown) => T | import("arktype").type.errors,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch (cause) {
    throw new MailboxThreadFetchError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new MailboxThreadFetchError(
      `The mailbox answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new MailboxThreadFetchError(
      `Unexpected mailbox response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** The timeline item shape — an alias, not a new type, so a mail-derived
 * row and a chat-native row are interchangeable everywhere the timeline
 * already consumes `MessageItem`. */
export type TimelineItem = MessageItem;

/**
 * Maps one mailbox thread's messages onto timeline items.
 *
 * `subject`, when present, prefixes the body as its own line — mail is the
 * only source that carries a subject, so it is folded into the one text
 * part a `MessageItem` has room for rather than inventing a field the rest
 * of chat-ui would have to learn about.
 *
 * `threadId` links a reply to its parent's own `id` (not its `messageId`,
 * which is the RFC-2822-style id the `inReplyTo`/`references` headers
 * carry) by resolving `inReplyTo` against every message's `messageId` in
 * this same batch. A message whose parent isn't in this batch — the root,
 * or a reply to a message this read didn't page in — keeps `threadId`
 * absent rather than guessing.
 */
export function threadMessagesToTimeline(
  messages: readonly MailboxThreadMessage[],
): TimelineItem[] {
  const idByMessageId = new Map<string, string>();
  for (const message of messages) {
    idByMessageId.set(message.messageId, message.id);
  }

  return messages.map((message) => {
    const parentId =
      message.inReplyTo !== undefined
        ? idByMessageId.get(message.inReplyTo)
        : undefined;
    const text =
      message.subject !== undefined &&
      message.subject !== null &&
      message.subject.length > 0
        ? `${message.subject}\n${message.body}`
        : message.body;
    return {
      id: message.id,
      createdAt: message.createdAt,
      parts: [{ kind: "text", text }],
      sender: { name: null, address: message.fromAddress },
      ...(parentId !== undefined ? { threadId: parentId } : {}),
    };
  });
}

/**
 * The same `{ kind: "workbench", id }` ref every mailbox writer stamps
 * (`apps/hub/src/mailbox-persist.ts`'s `hubMailboxResolveRefs`,
 * `packages/chat/src/mailbox-fanout.ts`'s `writeChatMailboxFanout`) — a
 * workbench is a plain tenant now (CL-8083), so the room a thread hangs
 * off is the same id a chat room is scoped to, and `tenantId` is carried
 * here only so a caller with just a tenant in hand has a matching call
 * shape; the stamped ref itself never varies by which of the two identical
 * ids produced it.
 */
export function roomRefFor(_tenantId: string, roomId: string): MailboxRef {
  return { kind: "workbench", id: roomId };
}

function mailboxBasePathFor(tenantId: string): string {
  return `/api/tenants/${tenantId}/mailbox`;
}

/** How many of a room's most-recently-active mail threads a feed page
 * loads bodies for. A room with more conversations than this simply
 * doesn't show the older ones yet — there is no "load more" for the root
 * feed today, matching the bound the old `GET /messages` page carried. */
const ROOM_FEED_THREAD_LIMIT = 50;

/** The `threadId` every root-level message resolves to (via
 * `./thread-feed.ts`'s `threadIdOf`) when it carries none of its own — the
 * same "root feed by default" contract the old `workbench_thread_messages`
 * store stated. A plain, never-a-mailbox-row-id sentinel, so it can never
 * collide with a real reply thread's id (a mail message's own row id). */
export const ROOM_FEED_ROOT_THREAD_ID = "__root__";

/**
 * The bounded page of a room's mail threads a feed reads bodies for —
 * newest activity first, same order `listMailboxThreadsClient` returns
 * them in. The only call site in this package that reads a
 * `MailboxThreadSummary`'s own fields — every other module works from
 * `MessageItem`/`WorkbenchThreadRow` instead, so a later swap to
 * Interchange's native mailbox thread shape touches only this file.
 */
async function listRoomThreadSummaries(tenantId: string, roomId: string) {
  const params = new URLSearchParams({
    refs: JSON.stringify([roomRefFor(tenantId, roomId)]),
    limit: String(ROOM_FEED_THREAD_LIMIT),
  });
  const page = await mailboxRequest(
    `${mailboxBasePathFor(tenantId)}/me/threads?${params.toString()}`,
    MailboxThreadListResponse,
  );
  return page.threads;
}

async function readRoomThread(tenantId: string, rootMessageId: string) {
  return mailboxRequest(
    `${mailboxBasePathFor(tenantId)}/me/threads/${encodeURIComponent(rootMessageId)}`,
    MailboxThreadReadResponse,
  );
}

/**
 * Every message across a room's visible mail threads, flattened into one
 * timeline (CL-8174 slice 2b) — a root message's own `threadId` stays
 * absent (see `threadMessagesToTimeline`), so it resolves to
 * `ROOM_FEED_ROOT_THREAD_ID` in `./thread-feed.ts`'s root-feed filter; a
 * reply's `threadId` is its thread's root message id, matching the
 * `WorkbenchThreadRow.id` `loadRoomThreadRows` hands out for the same
 * thread.
 */
export async function loadRoomMailboxMessages(
  tenantId: string,
  roomId: string,
): Promise<MessageItem[]> {
  const summaries = await listRoomThreadSummaries(tenantId, roomId);
  const perThread = await Promise.all(
    summaries.map((summary) => readRoomThread(tenantId, summary.rootMessageId)),
  );
  return perThread.flatMap((page) => threadMessagesToTimeline(page.messages));
}

/**
 * The reply-thread affordance rows for a room's visible mail threads —
 * only threads with at least one reply get a row, matching the old
 * `GET /threads` contract of listing only real reply activity.
 */
export async function loadRoomThreadRows(
  tenantId: string,
  roomId: string,
): Promise<{
  readonly rootThreadId: string;
  readonly items: readonly WorkbenchThreadRow[];
}> {
  const summaries = await listRoomThreadSummaries(tenantId, roomId);
  const items: WorkbenchThreadRow[] = summaries
    .filter((summary) => summary.messageCount > 1)
    .map((summary) => ({
      id: summary.rootId,
      kind: "reply",
      parentMessageId: summary.rootId,
      // Every mail thread this feed lists hangs directly off the root
      // feed — there is no depth-2 mailbox-native sub-thread concept
      // (see the fork-affordance note in `use-thread-navigation.ts`) —
      // so `parentThreadId` is always the sentinel root, matching
      // `useThreadNavigation`'s `depth1Threads` filter
      // (`thread.parentThreadId === rootThreadId`).
      parentThreadId: ROOM_FEED_ROOT_THREAD_ID,
      runRef: null,
      title: summary.subject ?? null,
      createdAt: summary.lastCreatedAt,
      replyCount: summary.messageCount - 1,
      lastActivityAt: summary.lastCreatedAt,
    }));
  return { rootThreadId: ROOM_FEED_ROOT_THREAD_ID, items };
}

/** The mailbox SSE endpoint a room's live-update subscription connects
 * to — the same stream `@corbits/inbox`'s Inbox surface reads. */
export function roomMailboxEventsUrl(tenantId: string): string {
  return `${mailboxBasePathFor(tenantId)}/me/inbox/events`;
}
