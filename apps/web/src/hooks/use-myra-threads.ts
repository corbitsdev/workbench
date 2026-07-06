import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
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
const inFlightCreates = new Map<string, Promise<MyraThread>>();

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

export function useCreateMyraThread() {
  const queryClient = useQueryClient();
  const { activeTenantId } = useActiveWorkbench();
  return useMutation({
    mutationFn: (label?: string) => {
      const tenantId = requireActiveTenant(activeTenantId);
      if (label !== undefined) return createMyraThread(tenantId, label);
      const existing = inFlightCreates.get(tenantId);
      if (existing) return existing;
      const create = createMyraThread(tenantId).finally(() => {
        inFlightCreates.delete(tenantId);
      });
      inFlightCreates.set(tenantId, create);
      return create;
    },
    onMutate: () => ({ tenantId: requireActiveTenant(activeTenantId) }),
    onSuccess: (thread, _label, context) => {
      queryClient.setQueryData<MyraThreadListItem[]>(
        myraThreadsKey(context.tenantId),
        (existing) => {
          if (!existing) return existing;
          if (existing.some((item) => item.id === thread.id)) return existing;
          return [thread, ...existing];
        },
      );
      void queryClient.invalidateQueries({
        queryKey: myraThreadsKey(context.tenantId),
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
function firstUserMessage(
  messages: { role: string; content: string }[],
): string | null {
  const first = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return first?.content ?? null;
}

export function useAutoTitleFirstMessage(
  active: MyraThread | null,
  messages: { role: string; content: string }[] = [],
): (text: string) => void {
  const generateTitle = useGenerateMyraThreadTitle();
  const titledRef = useRef<Set<string>>(new Set());
  // Read active through a ref so the returned callback always evaluates its
  // guards against the live render's value — correct even when invoked from an
  // effect that captured an earlier instance, or if a caller memoizes it.
  const activeRef = useRef(active);
  activeRef.current = active;

  const titleFromText = useCallback(
    (text: string) => {
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
    },
    [generateTitle],
  );

  useEffect(() => {
    if (!active || !isDefaultThreadLabel(active.label)) return;
    const firstMessage = firstUserMessage(messages);
    if (firstMessage === null) return;
    titleFromText(firstMessage);
  }, [active, messages, titleFromText]);

  return titleFromText;
}
