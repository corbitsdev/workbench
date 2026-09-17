// Pure adapter from a mailbox thread read onto the timeline item shape
// `use-workbench-feed.ts` already produces (CL-8174 slice 2a/2b). No new wire
// shape: a mail message becomes exactly the `MessageItem` the rest of
// chat-ui already knows how to render, so the timeline never has to branch
// on where a message came from.
//
// This file makes its own `fetch()` calls against the native
// `@corbits/mailbox` 1.0 routes (`/me/inbox/threads*`) and validates
// responses with local arktype schemas rather than a package client,
// since importing `@corbits/mailbox`'s server-only `migrations.ts` (a
// `node:crypto` user) at the value level is something a real bundler
// (Vite/Rollup) walks into even though only types are used, breaking the
// browser build. Per the owner ruling that `@corbits/mailbox` is a
// temporary, shrinking surface, every mailbox read in chat-ui goes
// through this one file, so swapping to Interchange's native mailbox
// thread shape later is a one-file change.
//
// A workbench is a plain Interchange tenant now (CL-8083): there is one
// chat room per tenant, so the tenant's own `/me/inbox` mailbox already IS
// that room's mail — there is no per-room `refs` filter to apply any more
// (the native 1.0 mount dropped `refs` entirely). `roomId` is kept on every
// function below only so a caller with just a room in hand has a matching
// call shape; it never narrows which threads come back.

import { type } from "arktype";
import type { MessageItem, WorkbenchThreadRow } from "./api";

export class MailboxThreadFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MailboxThreadFetchError";
  }
}

type MailboxThreadNode = {
  uid: number;
  flags: string[];
  envelope: {
    messageId: string;
    from: string;
    to: string[];
    subject: string;
    date: string;
    inReplyTo?: string;
    references: string[];
  };
  children: MailboxThreadNode[];
};

/** Hand-rolled rather than an arktype schema: the node shape is
 * self-referential (`children: MailboxThreadNode[]`), which arktype only
 * expresses through a named scope — more machinery than a same-shape-at-
 * every-depth check over a server response this file already trusts (the
 * hub's own `mountMailbox`, `enrichThread` in `@corbits/mailbox`'s
 * `mount.ts`) needs. */
function isMailboxThreadNode(value: unknown): value is MailboxThreadNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.uid !== "number") return false;
  if (!Array.isArray(node.flags) || !node.flags.every((flag) => typeof flag === "string")) {
    return false;
  }
  const envelope = node.envelope as Record<string, unknown> | undefined;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    typeof envelope.messageId !== "string" ||
    typeof envelope.from !== "string" ||
    !Array.isArray(envelope.to) ||
    typeof envelope.subject !== "string" ||
    typeof envelope.date !== "string" ||
    !Array.isArray(envelope.references)
  ) {
    return false;
  }
  if (!Array.isArray(node.children) || !node.children.every(isMailboxThreadNode)) {
    return false;
  }
  return true;
}

const MailboxThreadListResponse = type({
  threads: "unknown[]",
});

async function mailboxRequest<T>(
  path: string,
  schema: (input: unknown) => T | import("arktype").type.errors,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch (cause) {
    throw new MailboxThreadFetchError(cause instanceof Error ? cause.message : String(cause));
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

/** Flattens one thread tree (root plus every descendant) into its member
 * nodes, in the order `enrichThread` builds them (parent, then children). */
function flattenThread(node: MailboxThreadNode): MailboxThreadNode[] {
  return [node, ...node.children.flatMap(flattenThread)];
}

/**
 * Maps one thread tree's nodes onto timeline items.
 *
 * `subject`, when present, prefixes the body as its own line — mail is the
 * only source that carries a subject, so it is folded into the one text
 * part a `MessageItem` has room for rather than inventing a field the rest
 * of chat-ui would have to learn about.
 *
 * `threadId` links a reply to its parent's own `uid` (not its `messageId`,
 * which is the RFC-2822-style id the `inReplyTo`/`references` headers
 * carry) by walking the tree structure the mount already resolved —
 * `executeThread`'s own REFERENCES algorithm, not a second reconstruction
 * from headers here.
 */
export function threadTreeToTimeline(root: MailboxThreadNode): TimelineItem[] {
  const items: TimelineItem[] = [];
  function visit(node: MailboxThreadNode, parentUid: number | undefined) {
    const { envelope } = node;
    const text =
      envelope.subject.length > 0 ? `${envelope.subject}\n${envelope.from}` : envelope.from;
    items.push({
      id: String(node.uid),
      createdAt: envelope.date,
      parts: [{ kind: "text", text }],
      sender: { name: null, address: envelope.from },
      messageId: envelope.messageId,
      ...(parentUid !== undefined ? { threadId: String(parentUid) } : {}),
    });
    for (const child of node.children) visit(child, node.uid);
  }
  visit(root, undefined);
  return items;
}

function mailboxBasePathFor(tenantId: string): string {
  return `/api/tenants/${tenantId}/mailbox`;
}

/** How many of the tenant's most-recently-active mail threads a feed page
 * loads bodies for. More conversations than this simply don't show the
 * older ones yet — there is no "load more" for the root feed today,
 * matching the bound the old `GET /messages` page carried. */
const ROOM_FEED_THREAD_LIMIT = 50;

/** The `threadId` every root-level message resolves to (via
 * `./thread-feed.ts`'s `threadIdOf`) when it carries none of its own — the
 * same "root feed by default" contract the old `workbench_thread_messages`
 * store stated. A plain, never-a-mailbox-uid sentinel, so it can never
 * collide with a real reply thread's id (a mail message's own uid). */
export const ROOM_FEED_ROOT_THREAD_ID = "__root__";

async function listThreads(tenantId: string): Promise<MailboxThreadNode[]> {
  const page = await mailboxRequest(
    `${mailboxBasePathFor(tenantId)}/me/inbox/threads?folder=INBOX`,
    MailboxThreadListResponse,
  );
  return page.threads.map((raw) => {
    if (!isMailboxThreadNode(raw)) {
      throw new MailboxThreadFetchError("Unexpected mailbox thread node shape");
    }
    return raw;
  });
}

/**
 * Every message across the tenant's mailbox threads, flattened into one
 * timeline (CL-8174 slice 2b) — a root message's own `threadId` stays
 * absent (see `threadTreeToTimeline`), so it resolves to
 * `ROOM_FEED_ROOT_THREAD_ID` in `./thread-feed.ts`'s root-feed filter; a
 * reply's `threadId` is its parent's own uid, matching the
 * `WorkbenchThreadRow.id` `loadRoomThreadRows` hands out for the same
 * thread.
 */
export async function loadRoomMailboxMessages(
  tenantId: string,
  _roomId: string,
): Promise<MessageItem[]> {
  const threads = (await listThreads(tenantId)).slice(0, ROOM_FEED_THREAD_LIMIT);
  return threads.flatMap((root) => threadTreeToTimeline(root));
}

/**
 * The reply-thread affordance rows for the tenant's mailbox threads — only
 * threads with at least one reply get a row, matching the old
 * `GET /threads` contract of listing only real reply activity.
 */
export async function loadRoomThreadRows(
  tenantId: string,
  _roomId: string,
): Promise<{
  readonly rootThreadId: string;
  readonly items: readonly WorkbenchThreadRow[];
}> {
  const threads = (await listThreads(tenantId)).slice(0, ROOM_FEED_THREAD_LIMIT);
  const items: WorkbenchThreadRow[] = threads
    .map((root) => ({ root, members: flattenThread(root) }))
    .filter(({ members }) => members.length > 1)
    .map(({ root, members }) => ({
      id: String(root.uid),
      kind: "reply",
      parentMessageId: String(root.uid),
      // Every mail thread this feed lists hangs directly off the root
      // feed — there is no depth-2 mailbox-native sub-thread concept
      // (see the fork-affordance note in `use-thread-navigation.ts`) —
      // so `parentThreadId` is always the sentinel root, matching
      // `useThreadNavigation`'s `depth1Threads` filter
      // (`thread.parentThreadId === rootThreadId`).
      parentThreadId: ROOM_FEED_ROOT_THREAD_ID,
      runRef: null,
      title: root.envelope.subject.length > 0 ? root.envelope.subject : null,
      createdAt: members[members.length - 1]?.envelope.date ?? root.envelope.date,
      replyCount: members.length - 1,
      lastActivityAt: members[members.length - 1]?.envelope.date ?? root.envelope.date,
    }));
  return { rootThreadId: ROOM_FEED_ROOT_THREAD_ID, items };
}

/** The mailbox SSE endpoint a room's live-update subscription connects
 * to — the same stream `@corbits/mailbox`'s own inbox surface reads. */
export function roomMailboxEventsUrl(tenantId: string): string {
  return `${mailboxBasePathFor(tenantId)}/me/inbox/events`;
}
