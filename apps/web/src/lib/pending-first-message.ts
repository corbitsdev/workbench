// Hands a seeded first message to a freshly-created chat thread across the
// client-side navigation from the artifact page to /chats/:threadId. Kept in a
// module map (same SPA session, no serialization); ChatThreadPage takes it once
// the thread's session is ready, then it's gone.

const pending = new Map<string, string>();

export function setPendingFirstMessage(
  threadId: string,
  message: string,
): void {
  pending.set(threadId, message);
}

/** Returns the pending message for a thread and removes it (deliver-once). */
export function takePendingFirstMessage(threadId: string): string | null {
  const message = pending.get(threadId);
  if (message === undefined) return null;
  pending.delete(threadId);
  return message;
}
