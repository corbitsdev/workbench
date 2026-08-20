// Which thread the workspace is looking at, and how it gets there.
//
// A thread is a place the reader navigates to, but *what it contains* is a
// filter over the mailbox `use-workbench-feed` already loaded — so this
// hook owns only the navigation: which thread is open, which message a
// not-yet-created reply thread would hang off, and the two-level shape the
// threads menu and breadcrumb both read.
//
// Two levels, stop: a depth-1 thread hangs off the root thread; a depth-2
// sub-thread hangs off a depth-1 thread. The server resolves depth on a
// fork (redirecting to a sibling when the origin message already sits
// inside a sub-thread), so nothing here reasons about nesting beyond
// grouping what it is handed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@corbits/react-ui";
import { forkThread } from "./api";
import type { WorkbenchThreadRow } from "./api";
import { CHAT_STRINGS } from "./strings";

export interface ThreadNavigation {
  /** null = the workbench root feed. */
  readonly openThreadId: string | null;
  /** Set when the reader opened a reply on a message that has no thread
   * yet — the thread is created lazily, by the first send. */
  readonly pendingParentMessageId: string | null;
  /** Either of the above: the composer and timeline share one geometry
   * for "inside a thread", whether or not the thread exists yet. */
  readonly inThreadView: boolean;
  readonly openThread: WorkbenchThreadRow | undefined;
  /** A sub-thread's breadcrumb parent — undefined for a depth-1 thread
   * (or none open), which breadcrumbs straight back to the workbench. */
  readonly openThreadParent: WorkbenchThreadRow | undefined;
  readonly threadTitle: string;
  readonly depth1Threads: readonly WorkbenchThreadRow[];
  readonly subThreadsByParentId: ReadonlyMap<string, WorkbenchThreadRow[]>;
  readonly openThreadForMessage: (messageId: string) => void;
  readonly forkMessage: (messageId: string) => Promise<void>;
  readonly openThreadById: (threadId: string) => void;
  readonly closeThread: () => void;
}

export function useThreadNavigation(args: {
  readonly tenantId: string;
  readonly activeWorkbenchId: string | null;
  readonly threads: readonly WorkbenchThreadRow[];
  readonly rootThreadId: string;
  /** False until `GET /threads` has resolved once — until then an open
   * thread id cannot be judged stale, only unknown. */
  readonly threadsLoaded: boolean;
  readonly refetchThreads: () => Promise<unknown>;
}): ThreadNavigation {
  const {
    tenantId,
    activeWorkbenchId,
    threads,
    rootThreadId,
    threadsLoaded,
    refetchThreads,
  } = args;
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pendingParentMessageId, setPendingParentMessageId] = useState<
    string | null
  >(null);

  // Switching workbenches resets the view: a thread id belongs to the
  // workbench it came from.
  useEffect(() => {
    setOpenThreadId(null);
    setPendingParentMessageId(null);
  }, [activeWorkbenchId]);

  // A remembered thread id can outlive the run it named — across a hub
  // restart the reconnect-ownership challenge treats the run as dead and
  // every id under it disappears. That is a stale reference, not a
  // failure: drop it and fall back to the workbench's live feed rather
  // than leaving the reader staring at an empty thread.
  useEffect(() => {
    if (openThreadId === null || !threadsLoaded) return;
    if (!threads.some((thread) => thread.id === openThreadId)) {
      setOpenThreadId(null);
    }
  }, [openThreadId, threads, threadsLoaded]);

  const replyThreadFor = useCallback(
    (messageId: string) =>
      threads.find(
        (thread) =>
          thread.kind === "reply" && thread.parentMessageId === messageId,
      ),
    [threads],
  );

  const openThreadForMessage = useCallback(
    (messageId: string) => {
      const existing = replyThreadFor(messageId);
      if (existing !== undefined) {
        setPendingParentMessageId(null);
        setOpenThreadId(existing.id);
        return;
      }
      setOpenThreadId(null);
      setPendingParentMessageId(messageId);
    },
    [replyThreadFor],
  );

  /**
   * The fork affordance: any message inside an open thread can spawn a
   * sub-thread rooted at it. Unlike the lazy root-feed reply above, a fork
   * is created eagerly — the server resolves depth, so this UI never has
   * to reason about nesting itself.
   */
  const forkMessage = useCallback(
    async (messageId: string) => {
      if (activeWorkbenchId === null) return;
      const existing = replyThreadFor(messageId);
      if (existing !== undefined) {
        setPendingParentMessageId(null);
        setOpenThreadId(existing.id);
        return;
      }
      try {
        const forked = await forkThread(tenantId, activeWorkbenchId, messageId);
        await refetchThreads();
        setPendingParentMessageId(null);
        setOpenThreadId(forked.id);
      } catch {
        toast(CHAT_STRINGS.forkThreadError);
      }
    },
    [tenantId, activeWorkbenchId, replyThreadFor, refetchThreads],
  );

  /** Open a thread that already exists — from the threads menu, a
   * breadcrumb, or a send that just created one. */
  const openThreadById = useCallback((threadId: string) => {
    setPendingParentMessageId(null);
    setOpenThreadId(threadId);
  }, []);

  const closeThread = useCallback(() => {
    setOpenThreadId(null);
    setPendingParentMessageId(null);
  }, []);

  const replyThreads = useMemo(
    () => threads.filter((thread) => thread.kind === "reply"),
    [threads],
  );
  const depth1Threads = useMemo(
    () =>
      replyThreads.filter((thread) => thread.parentThreadId === rootThreadId),
    [replyThreads, rootThreadId],
  );
  const subThreadsByParentId = useMemo(() => {
    const map = new Map<string, WorkbenchThreadRow[]>();
    for (const thread of replyThreads) {
      if (
        thread.parentThreadId === null ||
        thread.parentThreadId === rootThreadId
      ) {
        continue;
      }
      const list = map.get(thread.parentThreadId) ?? [];
      map.set(thread.parentThreadId, [...list, thread]);
    }
    return map;
  }, [replyThreads, rootThreadId]);

  const openThread =
    openThreadId === null
      ? undefined
      : threads.find((thread) => thread.id === openThreadId);
  const openThreadParent =
    openThread?.parentThreadId !== undefined &&
    openThread.parentThreadId !== null &&
    openThread.parentThreadId !== rootThreadId
      ? threads.find((thread) => thread.id === openThread.parentThreadId)
      : undefined;

  return {
    openThreadId,
    pendingParentMessageId,
    inThreadView: openThreadId !== null || pendingParentMessageId !== null,
    openThread,
    openThreadParent,
    threadTitle:
      openThread?.title ??
      (pendingParentMessageId !== null ? "New thread" : "Thread"),
    depth1Threads,
    subThreadsByParentId,
    openThreadForMessage,
    forkMessage,
    openThreadById,
    closeThread,
  };
}
