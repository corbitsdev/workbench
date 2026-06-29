import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
  relaunchMyraThread,
  renameMyraThread,
  type MyraThread,
  type MyraThreadListItem,
} from "../lib/hub-api";
import { useActiveWorkbench } from "../lib/active-workbench-context";

/** Matches the hub's default labels ('Chat', 'Chat 2', …) — i.e. not user-set. */
export function isDefaultThreadLabel(label: string): boolean {
  return /^Chat( \d+)?$/.test(label.trim());
}

const MYRA_THREADS_KEY = "myra-threads";
function myraThreadsKey(tenantId: string | null) {
  return [MYRA_THREADS_KEY, tenantId] as const;
}
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

/**
 * Throws if invoked without an active workbench. The mutation hooks gate their
 * UI affordances on an active tenant, so this fail-loud guard only fires on a
 * programming error (calling a mutation while no workbench is selected), never
 * in normal use.
 */
function requireActiveTenant(tenantId: string | null): string {
  if (!tenantId) {
    throw new Error("No active workbench selected");
  }
  return tenantId;
}

export function useMyraThreads() {
  const { activeTenantId } = useActiveWorkbench();
  return useQuery<MyraThreadListItem[]>({
    queryKey: myraThreadsKey(activeTenantId),
    queryFn: () => listMyraThreads(requireActiveTenant(activeTenantId)),
    enabled: !!activeTenantId,
    staleTime: 60_000,
  });
}

/**
 * Opt-in "Update Myra" for one old thread (CL-2518). Relaunches that thread's
 * session against the latest Myra def so new tools load, then refetches the
 * list so the thread's `updateAvailable` flag clears.
 */
export function useRelaunchMyraThread() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: (id: string) =>
      relaunchMyraThread(requireActiveTenant(activeTenantId), id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: myraThreadsKey(activeTenantId),
      });
    },
  });
}

export function useCreateMyraThread() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: (label?: string) =>
      createMyraThread(requireActiveTenant(activeTenantId), label),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: myraThreadsKey(activeTenantId),
      });
    },
  });
}

export function useRenameMyraThread() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      renameMyraThread(requireActiveTenant(activeTenantId), id, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: myraThreadsKey(activeTenantId),
      });
    },
  });
}

export function useDeleteMyraThread() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: (id: string) =>
      deleteMyraThread(requireActiveTenant(activeTenantId), id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: myraThreadsKey(activeTenantId),
      });
    },
  });
}

export function useGenerateMyraThreadTitle() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: ({ id, firstMessage }: { id: string; firstMessage: string }) =>
      generateMyraThreadTitle(
        requireActiveTenant(activeTenantId),
        id,
        firstMessage,
      ),
    onSuccess: (thread) => {
      if (thread)
        void queryClient.invalidateQueries({
          queryKey: myraThreadsKey(activeTenantId),
        });
    },
  });
}

/**
 * Returns a callback that auto-titles `active` while it still carries a default
 * label. Shared by every Myra surface (full-page chat and the dock) so titling
 * fires wherever a thread is first used, not just on `/chats`. No-ops once the
 * thread has a custom label or has already been titled this mount. Re-titling is
 * allowed regardless of how many user turns the thread already has — a still
 * "Chat"-labelled thread always deserves another shot — and the hub re-checks
 * the default-label guard under a per-principal lock, so a redundant call from
 * another surface is a safe no-op, not an overwrite.
 */
export function useAutoTitleFirstMessage(
  active: MyraThread | null,
): (text: string) => void {
  const generateTitle = useGenerateMyraThreadTitle();
  const titledRef = useRef<Set<string>>(new Set());
  // Read active through a ref so the returned callback always evaluates its
  // guards against the live render's value — correct even when invoked from an
  // effect that captured an earlier instance, or if a caller memoizes it.
  const activeRef = useRef(active);
  activeRef.current = active;
  return (text: string) => {
    const thread = activeRef.current;
    if (!thread || !isDefaultThreadLabel(thread.label)) return;
    if (titledRef.current.has(thread.id)) return;
    // Latch up front to block a concurrent double-fire, then release on a hub
    // no-op (`thread: null`) or error so the next message can retry (CL-2449).
    titledRef.current.add(thread.id);
    generateTitle.mutate(
      { id: thread.id, firstMessage: text },
      {
        onSuccess: (updated) => {
          if (!updated) titledRef.current.delete(thread.id);
        },
        onError: () => {
          titledRef.current.delete(thread.id);
        },
      },
    );
  };
}
