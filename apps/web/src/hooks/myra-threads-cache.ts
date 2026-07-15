import type { QueryClient } from "@tanstack/react-query";

// Query-key helpers for the Myra thread list, kept in their own module so
// callers that only need to invalidate the cache (e.g. the chat session hook)
// don't pull in the full use-myra-threads dependency graph.
export const MYRA_THREADS_KEY = "myra-threads";

// The sidebar fetches a limited page while `/chats` and the chat surfaces fetch
// the full list, so a tenant has more than one cached thread query. The prefix
// (`[key, tenantId]`) matches every page for a tenant — mutations invalidate and
// patch through it so both the limited and full caches stay in sync.
export function myraThreadsPrefix(tenantId: string | null) {
  return [MYRA_THREADS_KEY, tenantId] as const;
}

export function myraThreadsKey(tenantId: string | null, limit?: number) {
  return [MYRA_THREADS_KEY, tenantId, limit ?? "all"] as const;
}

/**
 * Refetch every cached thread page for a tenant. Call after a user sends a
 * message: the hub bumps the thread's `lastActivityAt`, and this pulls the new
 * order so the active chat surfaces at the top of the sidebar and `/chats`.
 */
export function invalidateMyraThreads(
  queryClient: QueryClient,
  tenantId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: myraThreadsPrefix(tenantId),
  });
}

// Instances whose first message was sent from THIS client this session. The
// hub stamps `firstMessageAt` asynchronously (fire-and-forget after the mail
// POST), so a list refetch can race the stamp and still report the thread as
// unused — this local mark keeps it visible through that window (CL-3749).
const locallyUsedInstanceIds = new Set<string>();

/** Record that this client sent the thread's first message. */
export function markMyraThreadUsedLocally(instanceId: string): void {
  locallyUsedInstanceIds.add(instanceId);
}

/** Test-only: clear the local first-use marks between tests. */
export function resetLocallyUsedMyraThreads(): void {
  locallyUsedInstanceIds.clear();
}

/**
 * Whether a thread has ever received a user message. Unused threads stay out
 * of the sidebar and /chats so "+ New chat" never mutates the lists until the
 * chat is actually used (CL-3749). A missing `firstMessageAt` (older hub
 * without the field) counts as used — hiding is opt-in on positive evidence.
 */
export function isMyraThreadUsed(item: {
  instanceId: string;
  firstMessageAt?: string | null;
}): boolean {
  return (
    item.firstMessageAt !== null || locallyUsedInstanceIds.has(item.instanceId)
  );
}
