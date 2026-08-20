// What the timeline shows: the feed's loaded mailbox, sliced by wherever
// thread navigation has the reader standing.
//
// The two halves are deliberately separate — `use-workbench-feed` loads a
// workbench's mailbox without knowing which thread is open, and
// `use-thread-navigation` tracks which thread is open without knowing what
// has loaded — so this is the one place that joins them. Keeping the join
// here is also what stops the two hooks depending on each other.

import { useEffect, useMemo } from "react";
import { putReadState } from "./api";
import type { MessageItem } from "./api";
import { selectThreadFeed, threadAffordanceMeta } from "./thread-feed";
import type { ThreadAffordanceMeta } from "./timeline";
import type { FeedStatus, WorkbenchFeed } from "./use-workbench-feed";
import type { ThreadNavigation } from "./use-thread-navigation";

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

export function messagesStateFor(
  status: FeedStatus,
  items: readonly MessageItem[],
): MessagesState {
  return status.kind === "ready" ? { kind: "ready", items } : status;
}

export interface WorkbenchTimelineView {
  readonly messagesState: MessagesState;
  readonly threadMetaByMessageId: ReadonlyMap<string, ThreadAffordanceMeta>;
}

export function useWorkbenchTimelineView(args: {
  readonly tenantId: string;
  readonly activeWorkbenchId: string | null;
  readonly feed: WorkbenchFeed;
  readonly navigation: ThreadNavigation;
}): WorkbenchTimelineView {
  const { tenantId, activeWorkbenchId, feed, navigation } = args;
  const { loadedMessages, rootThreadId, threads, feedStatus } = feed;
  const { openThreadId, openThread, pendingParentMessageId } = navigation;

  // The parent a thread hangs off comes from the thread itself once it
  // exists, and from the message the reader is replying to before it
  // does — one value either way, so the feed never has to know which case
  // it is in.
  const parentMessageId =
    openThread?.parentMessageId ?? pendingParentMessageId ?? null;

  const feedItems = useMemo(
    () =>
      selectThreadFeed(loadedMessages, {
        openThreadId,
        parentMessageId,
        rootThreadId,
      }),
    [loadedMessages, openThreadId, parentMessageId, rootThreadId],
  );

  const threadMetaByMessageId = useMemo(
    () => threadAffordanceMeta(threads, loadedMessages),
    [threads, loadedMessages],
  );

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

  return {
    messagesState: messagesStateFor(feedStatus, feedItems),
    threadMetaByMessageId,
  };
}
