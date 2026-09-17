// One workbench's feed: the mailbox reads that make it up, every view the
// timeline can derive from them, and the single refresh that keeps them
// current (CL-6313; CL-8174 slice 2b).
//
// The feed reads through `@corbits/mailbox`'s own thread routes rather than
// `@corbits/chat`'s message/thread routes now: a workbench is a plain
// tenant (CL-8083), and every message posted to it already lands in the
// mailbox via the same fan-out the Inbox reads (see
// `packages/chat-ui/src/mailbox-timeline.ts`). Thread membership is a
// property of a message, not a function of which endpoint was called, so
// the root feed and every open thread are both filters over the one
// mailbox this hook loads — see `./thread-feed.ts`.
//
// Pins and reactions have no mailbox equivalent and are retired with this
// slice: no chip row, no pin toggle, no pinned strip.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  loadRoomMailboxMessages,
  loadRoomThreadRows,
  MailboxThreadFetchError,
  roomMailboxEventsUrl,
} from "./mailbox-timeline";
import type { MessageItem, MessagesResponse, WorkbenchThreadRow } from "./api";

/** Whether this workbench's mailbox has loaded, and why not if it hasn't.
 * The items themselves are a separate question — which slice of the
 * mailbox the reader is looking at — so they are not carried here. */
export type FeedStatus =
  | { readonly kind: "loading" }
  | {
      readonly kind: "error";
      readonly message: string;
      /** The workbench itself 404s, not just this load — retrying with the
       * same id can never succeed, so the UI trades "Try again" for an
       * honest way out instead. */
      readonly workbenchNotFound: boolean;
      /** A 401 means the session itself is gone — "Try again" would hit
       * the same 401 forever, so the UI offers a way to sign back in
       * instead of a retry that can never succeed. */
      readonly isUnauthorized: boolean;
    }
  | { readonly kind: "ready" };

/** How long a loaded feed counts as fresh. An agent turn emits dozens of
 * stream events in under a second; with a stale window every one of them
 * after the first is served from cache instead of hitting the hub. */
const CHAT_FEED_STALE_MS = 1_000;

/** How long stream events are gathered before one refetch goes out. Long
 * enough to swallow a turn's event burst, short enough that a reply still
 * appears immediately. */
const CHAT_FEED_COALESCE_MS = 250;

/** Stable empty defaults, so a query that hasn't resolved yet doesn't
 * hand the memos below a new array identity on every render. */
const NO_THREADS: readonly WorkbenchThreadRow[] = [];
const NO_MESSAGES: readonly MessageItem[] = [];

/** The three reads that make up one workbench's feed. They share a
 * prefix so a single `invalidateQueries` refreshes all of them. */
export function chatFeedQueryKeyPrefix(tenantId: string, workbenchId: string | null) {
  return ["chat", "feed", tenantId, workbenchId] as const;
}
export function chatMessagesQueryKey(tenantId: string, workbenchId: string | null) {
  return [...chatFeedQueryKeyPrefix(tenantId, workbenchId), "messages"] as const;
}
export function chatThreadsQueryKey(tenantId: string, workbenchId: string | null) {
  return [...chatFeedQueryKeyPrefix(tenantId, workbenchId), "threads"] as const;
}

/**
 * The `GET /threads` cache shape — shared by the optimistic-send path that
 * seeds a just-created reply thread before `openThreadById` runs
 * (CL-6660).
 */
export type ThreadsQueryData = {
  readonly rootThreadId: string;
  readonly items: readonly WorkbenchThreadRow[];
};

/**
 * Ensures a reply-thread row exists for `threadId`, and optionally bumps
 * its activity. A first in-reply-to send uses this to seed the row with
 * `parentMessageId` before navigation opens the thread; a stream echo
 * uses it when the row is still missing so "N replies" and open-by-id
 * have something to hang onto without a refetch (CL-6660).
 *
 * When the row already exists, `parentMessageId` fills in only if the
 * cached row still has `null` (a stream-seeded stub catching up to the
 * sender's known parent) — never overwrites a real parent.
 */
export function ensureReplyThreadRow(
  current: ThreadsQueryData,
  args: {
    readonly threadId: string;
    readonly createdAt: string;
    readonly parentMessageId?: string | null;
    /** When false, only insert-or-fill — never increment replyCount. */
    readonly bumpReplyCount?: boolean;
  },
): ThreadsQueryData {
  const bump = args.bumpReplyCount ?? true;
  const existing = current.items.find((row) => row.id === args.threadId);
  if (existing !== undefined) {
    const filledParent =
      args.parentMessageId !== undefined &&
      args.parentMessageId !== null &&
      existing.parentMessageId === null
        ? args.parentMessageId
        : existing.parentMessageId;
    const replyCount = bump ? existing.replyCount + 1 : existing.replyCount;
    const lastActivityAt = bump ? args.createdAt : existing.lastActivityAt;
    if (
      filledParent === existing.parentMessageId &&
      replyCount === existing.replyCount &&
      lastActivityAt === existing.lastActivityAt
    ) {
      return current;
    }
    return {
      ...current,
      items: current.items.map((row) =>
        row.id === args.threadId
          ? {
              ...row,
              parentMessageId: filledParent,
              replyCount,
              lastActivityAt,
            }
          : row,
      ),
    };
  }
  const newRow: WorkbenchThreadRow = {
    id: args.threadId,
    kind: "reply",
    parentMessageId: args.parentMessageId ?? null,
    parentThreadId: current.rootThreadId === "" ? null : current.rootThreadId,
    runRef: null,
    title: null,
    createdAt: args.createdAt,
    replyCount: bump ? 1 : 0,
    lastActivityAt: bump ? args.createdAt : null,
  };
  return { ...current, items: [...current.items, newRow] };
}

export interface WorkbenchFeed {
  readonly threads: readonly WorkbenchThreadRow[];
  readonly rootThreadId: string;
  /** Every message in the workbench, unfiltered. What thread a reader is
   * looking at selects a slice of this — see `./thread-feed.ts`. */
  readonly loadedMessages: readonly MessageItem[];
  readonly feedStatus: FeedStatus;
  readonly threadsLoaded: boolean;
  readonly refreshFeed: () => void;
  readonly refetchMessages: () => void;
  readonly refetchThreads: () => Promise<unknown>;
}

export function useWorkbenchFeed(args: {
  readonly tenantId: string;
  readonly activeWorkbenchId: string | null;
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
}): WorkbenchFeed {
  const { tenantId, activeWorkbenchId, onWorkbenchNotFound } = args;
  const queryClient = useQueryClient();
  // Scoped to the (tenantId, workbenchId) the timer was scheduled for —
  // not a bare timer handle — so a pending refresh for one workbench can
  // never make another workbench's `refreshFeed()` call early-return, and
  // never fires an invalidation against a query key that is no longer the
  // active one (CL-7198).
  const refreshTimerRef = useRef<
    | {
        readonly tenantId: string;
        readonly workbenchId: string;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);

  const messagesQuery = useQuery({
    queryKey: chatMessagesQueryKey(tenantId, activeWorkbenchId),
    // Kept as `{ items }` — the same `MessagesResponse` shape the old
    // `GET .../messages` read produced — so `use-optimistic-sends.ts`'s
    // own optimistic writes into this cache (which target `.items`,
    // wholly independent of where the confirmed rows came from) need no
    // changes for this slice's fetch-source swap.
    queryFn: async (): Promise<MessagesResponse> => ({
      items: await loadRoomMailboxMessages(tenantId, activeWorkbenchId ?? ""),
    }),
    enabled: activeWorkbenchId !== null,
    staleTime: CHAT_FEED_STALE_MS,
  });
  const threadsQuery = useQuery({
    queryKey: chatThreadsQueryKey(tenantId, activeWorkbenchId),
    queryFn: () => loadRoomThreadRows(tenantId, activeWorkbenchId ?? ""),
    enabled: activeWorkbenchId !== null,
    staleTime: CHAT_FEED_STALE_MS,
  });

  const threads = threadsQuery.data?.items ?? NO_THREADS;
  const rootThreadId = threadsQuery.data?.rootThreadId ?? "";
  const loadedMessages = messagesQuery.data?.items ?? NO_MESSAGES;

  // A 401 is terminal for this session: keep refetching and the app would
  // hammer the hub unauthenticated forever, so every refresh trigger
  // below checks this first. A 404 means the workbench itself is gone
  // (deleted, or a stale Recents entry that outlived it) — not a
  // transient failure a retry could fix.
  const messagesError = messagesQuery.error;
  const isUnauthorized =
    messagesError instanceof MailboxThreadFetchError && messagesError.status === 401;
  const workbenchNotFound =
    messagesError instanceof MailboxThreadFetchError && messagesError.status === 404;

  // React Query keeps the last successful data through a failed refetch,
  // so a background failure leaves the timeline exactly as it was and
  // only a load with nothing to show yet surfaces the error page.
  const feedStatus: FeedStatus = useMemo(() => {
    if (activeWorkbenchId === null) return { kind: "loading" };
    if (messagesQuery.data !== undefined) return { kind: "ready" };
    if (messagesError !== null) {
      // Never the raw `MailboxThreadFetchError` message verbatim — like
      // `describeChatError`, it can embed the request path. `workbenchNotFound`
      // and `isUnauthorized` below carry the two statuses the UI gives its
      // own dedicated copy and recovery to; everything else gets this one
      // plain-language fallback.
      return {
        kind: "error",
        message: "Couldn't load messages.",
        workbenchNotFound,
        isUnauthorized,
      };
    }
    return { kind: "loading" };
  }, [activeWorkbenchId, messagesQuery.data, messagesError, workbenchNotFound, isUnauthorized]);

  useEffect(() => {
    if (workbenchNotFound && activeWorkbenchId !== null) {
      onWorkbenchNotFound?.(activeWorkbenchId);
    }
  }, [workbenchNotFound, activeWorkbenchId, onWorkbenchNotFound]);

  /** Every read of this workbench's feed, refetched as one. Concurrent
   * invalidations of a key collapse into a single request, which is what
   * makes an agent turn's burst of stream events cost one refresh rather
   * than one per event. */
  const refreshFeed = useCallback(() => {
    if (activeWorkbenchId === null || isUnauthorized) return;
    // Trailing-edge, because `invalidateQueries` refetches whether or not
    // the data is stale: React Query dedupes requests already in flight,
    // but an agent turn emits stream events faster than a round-trip
    // completes, so invalidating on each one still walks the hub once per
    // gap between responses. Collapsing the burst into one refetch per
    // window is the difference between ~40 requests per turn and ~2.
    const pending = refreshTimerRef.current;
    if (pending !== undefined) {
      if (pending.tenantId === tenantId && pending.workbenchId === activeWorkbenchId) {
        return;
      }
      // A timer scheduled for a workbench the reader has since left —
      // clear it rather than let it invalidate that now-inactive query key.
      clearTimeout(pending.timer);
    }
    const workbenchId = activeWorkbenchId;
    refreshTimerRef.current = {
      tenantId,
      workbenchId,
      timer: setTimeout(() => {
        refreshTimerRef.current = undefined;
        void queryClient.invalidateQueries({
          queryKey: chatFeedQueryKeyPrefix(tenantId, workbenchId),
        });
      }, CHAT_FEED_COALESCE_MS),
    };
  }, [queryClient, tenantId, activeWorkbenchId, isUnauthorized]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== undefined) {
        clearTimeout(refreshTimerRef.current.timer);
        refreshTimerRef.current = undefined;
      }
    },
    [tenantId, activeWorkbenchId],
  );

  // Live updates: the mailbox's own SSE stream (the same one Inbox reads)
  // rather than a bespoke chat one — an event names the affected mail
  // message's id and (optionally) what happened to it, never the full
  // row, so the only thing a subscriber can safely do with it is refresh
  // the feed it might belong to. Coalesced through the same `refreshFeed`
  // every other trigger uses, so a burst of mail events costs one refetch.
  useEffect(() => {
    if (activeWorkbenchId === null) return;
    // A host with no `EventSource` at all (an older test harness that
    // never stubs one, matching `useWorkbenchStream`'s own contract) gets
    // no live updates rather than a thrown error — `refreshFeed` still
    // runs from every other trigger (send, thread navigation, tab focus).
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(roomMailboxEventsUrl(tenantId));
    source.addEventListener("mailbox", () => refreshFeed());
    return () => source.close();
  }, [tenantId, activeWorkbenchId, refreshFeed]);

  return {
    threads,
    rootThreadId,
    loadedMessages,
    feedStatus,
    threadsLoaded: threadsQuery.data !== undefined,
    refreshFeed,
    refetchMessages: () => void messagesQuery.refetch(),
    refetchThreads: () => threadsQuery.refetch(),
  };
}
