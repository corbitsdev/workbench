// One workbench's feed: the three reads that make it up, every view the
// timeline can derive from them, and the single refresh that keeps them
// current (CL-6313).
//
// Thread membership is a property of a message, not a function of which
// endpoint was called, so the root feed, any open thread, and the reply
// counts on each thread affordance are all filters over one cached
// mailbox — see `./thread-feed.ts`. That is what lets an agent turn's
// burst of stream events cost one refetch instead of one request per
// thread per event.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UnauthenticatedError } from "@corbits/api-query";
import {
  ChatApiError,
  describeChatError,
  listMessages,
  listPinnedMessages,
  listThreads,
  putReadState,
} from "./api";
import type { MessageItem, PinnedMessage, WorkbenchThreadRow } from "./api";
import { selectThreadFeed, threadAffordanceMeta } from "./thread-feed";
import type { ThreadAffordanceMeta } from "./timeline";

/** What the timeline renders, as a state the view can switch on. */
export type MessagesState =
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
  | { readonly kind: "ready"; readonly items: readonly MessageItem[] };

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
const NO_PINNED_MESSAGES: readonly PinnedMessage[] = [];

/** The three reads that make up one workbench's feed. They share a
 * prefix so a single `invalidateQueries` refreshes all of them. */
export function chatFeedQueryKeyPrefix(
  tenantId: string,
  workbenchId: string | null,
) {
  return ["chat", "feed", tenantId, workbenchId] as const;
}
export function chatMessagesQueryKey(
  tenantId: string,
  workbenchId: string | null,
) {
  return [
    ...chatFeedQueryKeyPrefix(tenantId, workbenchId),
    "messages",
  ] as const;
}
export function chatThreadsQueryKey(
  tenantId: string,
  workbenchId: string | null,
) {
  return [...chatFeedQueryKeyPrefix(tenantId, workbenchId), "threads"] as const;
}
export function chatPinsQueryKey(tenantId: string, workbenchId: string | null) {
  return [...chatFeedQueryKeyPrefix(tenantId, workbenchId), "pins"] as const;
}

export interface WorkbenchFeed {
  readonly threads: readonly WorkbenchThreadRow[];
  readonly rootThreadId: string;
  readonly pinnedMessages: readonly PinnedMessage[];
  readonly threadMetaByMessageId: ReadonlyMap<string, ThreadAffordanceMeta>;
  readonly messagesState: MessagesState;
  readonly threadsLoaded: boolean;
  readonly refreshFeed: () => void;
  readonly refetchMessages: () => void;
  readonly refetchThreads: () => Promise<unknown>;
}

export function useWorkbenchFeed(args: {
  readonly tenantId: string;
  readonly activeWorkbenchId: string | null;
  readonly openThreadId: string | null;
  readonly pendingParentMessageId: string | null;
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
}): WorkbenchFeed {
  const {
    tenantId,
    activeWorkbenchId,
    openThreadId,
    pendingParentMessageId,
    onWorkbenchNotFound,
  } = args;
  const queryClient = useQueryClient();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Threads and the mailbox are two queries, and every view the timeline
  // can show is derived from them (CL-6313). Each message carries the
  // thread it belongs to, so opening a thread filters data already
  // loaded rather than calling a different endpoint — which is what lets
  // a burst of stream events collapse into a single refetch instead of
  // one request per thread per event.
  const messagesQuery = useQuery({
    queryKey: chatMessagesQueryKey(tenantId, activeWorkbenchId),
    queryFn: () => listMessages(tenantId, activeWorkbenchId ?? ""),
    enabled: activeWorkbenchId !== null,
    staleTime: CHAT_FEED_STALE_MS,
  });
  const threadsQuery = useQuery({
    queryKey: chatThreadsQueryKey(tenantId, activeWorkbenchId),
    queryFn: () => listThreads(tenantId, activeWorkbenchId ?? ""),
    enabled: activeWorkbenchId !== null,
    staleTime: CHAT_FEED_STALE_MS,
  });
  const pinsQuery = useQuery({
    queryKey: chatPinsQueryKey(tenantId, activeWorkbenchId),
    // No `pins` store on this host, or a transient read failure — either
    // way the strip just doesn't show, the same "absent store, absent
    // surface" contract the wire's own `pinned` field follows.
    queryFn: () =>
      listPinnedMessages(tenantId, activeWorkbenchId ?? "").catch(
        () => [] as readonly PinnedMessage[],
      ),
    enabled: activeWorkbenchId !== null,
    staleTime: CHAT_FEED_STALE_MS,
  });

  const threads = threadsQuery.data?.items ?? NO_THREADS;
  const rootThreadId = threadsQuery.data?.rootThreadId ?? "";
  const pinnedMessages = pinsQuery.data ?? NO_PINNED_MESSAGES;
  const loadedMessages = messagesQuery.data?.items ?? NO_MESSAGES;

  // The parent a thread hangs off comes from the thread itself once it
  // exists, and from the message the reader is replying to before it
  // does — one value either way, so the feed never has to know which
  // case it is in.
  const threadParentMessageId =
    threads.find((thread) => thread.id === openThreadId)?.parentMessageId ??
    pendingParentMessageId;
  const feedItems = useMemo(
    () =>
      selectThreadFeed(loadedMessages, {
        openThreadId,
        parentMessageId: threadParentMessageId,
        rootThreadId,
      }),
    [loadedMessages, openThreadId, threadParentMessageId, rootThreadId],
  );
  const threadMetaByMessageId = useMemo(
    () => threadAffordanceMeta(threads, loadedMessages),
    [threads, loadedMessages],
  );

  // A 401 is terminal for this session: keep refetching and the app would
  // hammer the hub unauthenticated forever, so every refresh trigger
  // below checks this first. A 404 means the workbench itself is gone
  // (deleted, or a stale Recents entry that outlived it) — not a
  // transient failure a retry could fix.
  const messagesError = messagesQuery.error;
  const isUnauthorized =
    messagesError instanceof UnauthenticatedError ||
    (messagesError instanceof ChatApiError && messagesError.status === 401);
  const workbenchNotFound =
    messagesError instanceof ChatApiError && messagesError.status === 404;

  // React Query keeps the last successful data through a failed refetch,
  // so a background failure leaves the timeline exactly as it was and
  // only a load with nothing to show yet surfaces the error page.
  const messagesState: MessagesState = useMemo(() => {
    if (activeWorkbenchId === null) return { kind: "loading" };
    if (messagesQuery.data !== undefined) {
      return { kind: "ready", items: feedItems };
    }
    if (messagesError !== null) {
      return {
        kind: "error",
        message: describeChatError(messagesError, "Couldn't load messages."),
        workbenchNotFound,
        isUnauthorized,
      };
    }
    return { kind: "loading" };
  }, [
    activeWorkbenchId,
    messagesQuery.data,
    feedItems,
    messagesError,
    workbenchNotFound,
    isUnauthorized,
  ]);

  useEffect(() => {
    if (workbenchNotFound && activeWorkbenchId !== null) {
      onWorkbenchNotFound?.(activeWorkbenchId);
    }
  }, [workbenchNotFound, activeWorkbenchId, onWorkbenchNotFound]);

  // Marking read follows the root feed only: a reader inside a thread
  // hasn't seen the main timeline, so advancing the cursor there would
  // clear an unread badge for messages they never looked at.
  useEffect(() => {
    if (activeWorkbenchId === null) return;
    if (openThreadId !== null || pendingParentMessageId !== null) return;
    const last = feedItems.at(-1);
    if (last === undefined) return;
    void putReadState(tenantId, activeWorkbenchId, {
      lastSeenCreatedAt: last.createdAt,
      lastSeenId: last.id,
    }).catch(() => undefined);
  }, [
    tenantId,
    activeWorkbenchId,
    openThreadId,
    pendingParentMessageId,
    feedItems,
  ]);

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
    if (refreshTimerRef.current !== undefined) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = undefined;
      void queryClient.invalidateQueries({
        queryKey: chatFeedQueryKeyPrefix(tenantId, activeWorkbenchId),
      });
    }, CHAT_FEED_COALESCE_MS);
  }, [queryClient, tenantId, activeWorkbenchId, isUnauthorized]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== undefined) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );
  return {
    threads,
    rootThreadId,
    pinnedMessages,
    threadMetaByMessageId,
    messagesState,
    threadsLoaded: threadsQuery.data !== undefined,
    refreshFeed,
    refetchMessages: () => void messagesQuery.refetch(),
    refetchThreads: () => threadsQuery.refetch(),
  };
}
