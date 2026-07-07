import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isDefaultMyraThreadLabel,
  myraThreadTitleFromFirstMessage,
} from "@workbench/shared";
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
  return isDefaultMyraThreadLabel(label);
}

const MYRA_THREADS_KEY = "myra-threads";
function myraThreadsKey(tenantId: string | null) {
  return [MYRA_THREADS_KEY, tenantId] as const;
}
const LAST_ACTIVE_THREAD_KEY = "myra-last-active-thread";
const inFlightCreates = new Map<string, Promise<MyraThread>>();

// Titling is fire-and-forget on the hub: POST /title returns immediately and
// the real title lands seconds later (the LLM turn). A single onSettled refetch
// races that write and loses, and nothing else refetches the list — so the new
// title never appears until reload (CL-2872). While a title is in flight we
// poll the thread list until the generated title lands, then stop.
export const TITLE_POLL_INTERVAL_MS = 2_000;
// Failure-case ceiling only: the early-stop below ends polling the moment the
// title lands (~2s typical). This bounds the wait when the hub never produces a
// title (its turn timed out). It is deliberately kept above the hub's own
// title-turn deadline (HUB_MYRA_TITLE_TURN_TIMEOUT_MS, default 45s) plus margin
// — if an operator raises that env var past this ceiling, raise this too, or a
// slow-but-successful title will land after we stop polling. See the matching
// note at DEFAULT_HUB_MYRA_TITLE_TURN_TIMEOUT_MS in apps/hub/src/config.ts.
const TITLE_POLL_WINDOW_MS = 60_000;

type TitlePoll = { until: number; pending: Map<string, string> };
// tenantId -> { window ceiling, pending threadId -> optimistic label }.
const titlePolls = new Map<string, TitlePoll>();

/**
 * Record that a title turn is in flight for `threadId`, storing the optimistic
 * label we showed so the poll can recognise when the real title has replaced it.
 */
export function markTitlingActive(
  tenantId: string,
  threadId: string,
  optimisticLabel: string,
  now = Date.now(),
): void {
  const existing = titlePolls.get(tenantId);
  const pending = existing?.pending ?? new Map<string, string>();
  pending.set(threadId, optimisticLabel);
  titlePolls.set(tenantId, { until: now + TITLE_POLL_WINDOW_MS, pending });
}

/**
 * Poll interval for the thread list while a title is still landing, or false
 * once every pending title has landed or the window ceiling is hit. Drops a
 * pending thread as soon as its label is non-default and no longer the
 * optimistic fallback, and prunes the tenant entry so the map stays bounded.
 */
export function titlePollInterval(
  tenantId: string | null,
  threads: readonly MyraThreadListItem[] | undefined,
  now = Date.now(),
): number | false {
  if (!tenantId) return false;
  const poll = titlePolls.get(tenantId);
  if (!poll) return false;
  if (threads) {
    for (const [threadId, optimistic] of poll.pending) {
      const item = threads.find((t) => t.id === threadId);
      if (
        item &&
        !isDefaultMyraThreadLabel(item.label) &&
        item.label !== optimistic
      ) {
        poll.pending.delete(threadId);
      }
    }
  }
  if (poll.pending.size === 0 || now >= poll.until) {
    titlePolls.delete(tenantId);
    return false;
  }
  return TITLE_POLL_INTERVAL_MS;
}

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
    refetchInterval: (query) =>
      titlePollInterval(activeTenantId, query.state.data),
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
    onMutate: ({ id, firstMessage }) => {
      const tenantId = requireActiveTenant(activeTenantId);
      const label = myraThreadTitleFromFirstMessage(firstMessage);
      // The real title lands asynchronously; poll the list until it replaces
      // this optimistic label.
      markTitlingActive(tenantId, id, label);
      queryClient.setQueryData<MyraThreadListItem[]>(
        myraThreadsKey(tenantId),
        (existing) => {
          if (!existing) return existing;
          return existing.map((item) =>
            item.id === id ? { ...item, label } : item,
          );
        },
      );
    },
    // The hub accepts titling asynchronously and returns { thread: null }, so
    // there is no title to read from the response — the polling window opened in
    // onMutate is what surfaces the eventual title. This first invalidation just
    // kicks the query so refetchInterval begins scheduling polls.
    onSettled: () => {
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
  messagesInstanceId: string | null = null,
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
      // Latch up front to block a concurrent double-fire. The hub accepts titling
      // asynchronously (`thread: null`); only release the latch on request error.
      titledRef.current.add(thread.id);
      generateTitle.mutate(
        { id: thread.id, firstMessage: text },
        {
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
    // `messages` come from the live session, which reconnects to a switched
    // thread in a post-commit effect — so on the render right after "+ New
    // chat", `active` is already the new thread while `messages` still hold the
    // previous thread's transcript. Titling then would name the new thread from
    // the old thread's first message (CL-2882). Only trust the transcript once
    // the session has resolved to the active thread's own instance.
    if (messagesInstanceId !== active.instanceId) return;
    const firstMessage = firstUserMessage(messages);
    if (firstMessage === null) return;
    titleFromText(firstMessage);
  }, [active, messages, messagesInstanceId, titleFromText]);

  return titleFromText;
}
