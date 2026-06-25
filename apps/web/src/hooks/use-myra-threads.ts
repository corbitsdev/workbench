import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
  renameMyraThread,
  type MyraThread,
} from "../lib/hub-api";

/** Matches the hub's default labels ('Chat', 'Chat 2', …) — i.e. not user-set. */
export function isDefaultThreadLabel(label: string): boolean {
  return /^Chat( \d+)?$/.test(label.trim());
}

const MYRA_THREADS_KEY = ["myra-threads"] as const;
const LAST_ACTIVE_THREAD_KEY = "myra-last-active-thread";

export function readLastActiveThreadId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

export function writeLastActiveThreadId(threadId: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_THREAD_KEY, threadId);
  } catch {
    // localStorage unavailable
  }
}

/**
 * Resolve the thread to land on: the explicit id if it still exists, else the
 * last-active stored id if valid, else the first thread. Returns null only when
 * the member has no threads yet.
 */
export function resolveActiveThread(
  threads: MyraThread[],
  explicitId?: string | null,
): MyraThread | null {
  if (threads.length === 0) return null;
  if (explicitId) {
    const match = threads.find((t) => t.id === explicitId);
    if (match) return match;
  }
  const stored = readLastActiveThreadId();
  if (stored) {
    const match = threads.find((t) => t.id === stored);
    if (match) return match;
  }
  return threads[0] ?? null;
}

export function useMyraThreads() {
  return useQuery<MyraThread[]>({
    queryKey: MYRA_THREADS_KEY,
    queryFn: listMyraThreads,
    staleTime: 60_000,
  });
}

export function useCreateMyraThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label?: string) => createMyraThread(label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MYRA_THREADS_KEY });
    },
  });
}

export function useRenameMyraThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      renameMyraThread(id, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MYRA_THREADS_KEY });
    },
  });
}

export function useDeleteMyraThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMyraThread(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MYRA_THREADS_KEY });
    },
  });
}

export function useGenerateMyraThreadTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, firstMessage }: { id: string; firstMessage: string }) =>
      generateMyraThreadTitle(id, firstMessage),
    onSuccess: (thread) => {
      if (thread)
        void queryClient.invalidateQueries({ queryKey: MYRA_THREADS_KEY });
    },
  });
}

/**
 * Returns a callback that auto-titles `active` from its first user message.
 * Shared by every Myra surface (full-page chat and the dock) so titling fires
 * wherever a thread is first used, not just on `/chats`. No-ops once the thread
 * has a custom label, once it has already been titled while this surface is
 * mounted, or once a user turn already exists in the stream. (The hub re-checks
 * the default-label guard under a per-principal lock, so a redundant call from
 * another surface is a safe no-op, not an overwrite.)
 */
export function useAutoTitleFirstMessage(
  active: MyraThread | null,
  messages: readonly { role: string }[],
): (text: string) => void {
  const generateTitle = useGenerateMyraThreadTitle();
  const titledRef = useRef<Set<string>>(new Set());
  // Read active/messages through refs so the returned callback always evaluates
  // its guards against the live render's values — correct even when invoked from
  // an effect that captured an earlier instance, or if a caller memoizes it.
  const activeRef = useRef(active);
  activeRef.current = active;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  return (text: string) => {
    const thread = activeRef.current;
    if (!thread || !isDefaultThreadLabel(thread.label)) return;
    if (titledRef.current.has(thread.id)) return;
    if (messagesRef.current.some((m) => m.role === "user")) return;
    titledRef.current.add(thread.id);
    generateTitle.mutate({ id: thread.id, firstMessage: text });
  };
}
