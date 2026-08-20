// Deriving what the timeline shows from one loaded mailbox (CL-6313).
//
// Every message carries the thread it belongs to (`GET /messages` stamps
// it — see `resolveThreadMembership` in `packages/chat/src/routes.ts`), so
// "which thread am I looking at" is a filter over data the client already
// holds, not a different endpoint to call. That is what lets a single
// query serve the root feed, every open thread, and the reply counts on
// each thread affordance, instead of a refresh fanning out one request
// per thread.

import type { MessageItem } from "./api";
import type { ThreadAffordanceMeta } from "./timeline";

/** The `GET /threads` row fields this module reads. */
export type ThreadActivityRow = {
  readonly id: string;
  readonly kind: "root" | "reply" | "delivery";
  readonly parentMessageId: string | null;
  readonly replyCount: number;
  readonly lastActivityAt: string | null;
};

export type ThreadFeedView = {
  readonly openThreadId: string | null;
  /** The message the open thread hangs off, or — with no `openThreadId`
   * — the message a reply thread is about to be created from. Either
   * way it is the context the thread is unreadable without. */
  readonly parentMessageId: string | null;
  /** Empty until `GET /threads` resolves one, or on a host with no
   * thread store at all — either way there is no membership to filter
   * by, so the whole mailbox is the feed. */
  readonly rootThreadId: string;
};

function oldestFirst(items: readonly MessageItem[]): MessageItem[] {
  return [...items].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * The root thread IS the workbench feed, so a message carrying no
 * membership belongs to it — the same "root feed by default" contract
 * the server resolves against. Every message reaching the workbench
 * outside `POST /messages` (agent replies, approve blocks, join notices)
 * arrives that way.
 */
function threadIdOf(item: MessageItem, rootThreadId: string): string {
  return item.threadId ?? rootThreadId;
}

/**
 * The messages the timeline renders, oldest-first.
 *
 * An open thread is shown with its parent message prepended: a thread
 * hangs off a message the reader was just looking at, and rendering it
 * without that message strands the conversation context. A brand-new
 * reply thread has no replies yet, so the parent is all there is.
 */
export function selectThreadFeed(
  items: readonly MessageItem[],
  view: ThreadFeedView,
): MessageItem[] {
  if (view.openThreadId !== null) {
    const inThread = oldestFirst(
      items.filter(
        (item) => threadIdOf(item, view.rootThreadId) === view.openThreadId,
      ),
    );
    return withParent(inThread, items, view.parentMessageId);
  }
  if (view.parentMessageId !== null) {
    return withParent([], items, view.parentMessageId);
  }
  if (view.rootThreadId === "") return oldestFirst(items);
  return oldestFirst(
    items.filter(
      (item) => threadIdOf(item, view.rootThreadId) === view.rootThreadId,
    ),
  );
}

/** A parent that isn't in the loaded page (deleted, or older than the
 * fetched window) degrades to the bare thread rather than an error. */
function withParent(
  thread: readonly MessageItem[],
  all: readonly MessageItem[],
  parentMessageId: string | null,
): MessageItem[] {
  if (parentMessageId === null) return [...thread];
  if (thread.some((item) => item.id === parentMessageId)) return [...thread];
  const parent = all.find((item) => item.id === parentMessageId);
  return parent === undefined ? [...thread] : [parent, ...thread];
}

/**
 * Reply-thread affordances keyed by the message each thread hangs off.
 * Counts and timestamps come from the `GET /threads` row; only the
 * participant faces are derived from the loaded messages, and both are
 * free of any per-thread request.
 *
 * The root thread is deliberately absent: it is the feed itself, not a
 * thread to open from a message.
 */
export function threadAffordanceMeta(
  rows: readonly ThreadActivityRow[],
  items: readonly MessageItem[],
): ReadonlyMap<string, ThreadAffordanceMeta> {
  const addressesByThreadId = new Map<string, string[]>();
  for (const item of items) {
    if (item.threadId === undefined) continue;
    const address = item.sender?.address;
    if (typeof address !== "string") continue;
    const current = addressesByThreadId.get(item.threadId);
    if (current === undefined) {
      addressesByThreadId.set(item.threadId, [address]);
    } else if (!current.includes(address)) {
      current.push(address);
    }
  }

  const meta = new Map<string, ThreadAffordanceMeta>();
  for (const row of rows) {
    if (row.kind === "root" || row.parentMessageId === null) continue;
    meta.set(row.parentMessageId, {
      replyCount: row.replyCount,
      lastActivityAt: row.lastActivityAt,
      participantAddresses: addressesByThreadId.get(row.id) ?? [],
    });
  }
  return meta;
}
