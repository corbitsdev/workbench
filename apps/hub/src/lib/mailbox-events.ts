import { type } from "arktype";

// A delivery signal only, never mail content — the client refetches the
// authorized /me/inbox route on receipt. Mirrors the approvals-events bus
// (apps/hub/src/lib/approvals-events.ts) but keyed by principalId rather than
// tenantId, since a mailbox row belongs to exactly one recipient principal.
export const MailboxEventSchema = type({
  type: "'mailbox'",
  id: "string",
});
export type MailboxEvent = typeof MailboxEventSchema.infer;

type MailboxEventListener = (event: MailboxEvent) => void;

export interface MailboxEventBus {
  publish(principalId: string, event: MailboxEvent): void;
  subscribe(principalId: string, listener: MailboxEventListener): () => void;
}

// In-process pub/sub keyed by principalId. Each principal may hold several
// open connections (multiple tabs/devices), so the value is a Set rather than
// a single slot — every connection for that principal receives every publish,
// and disconnecting one never affects the others. Single-hub-replica scope,
// same assumption as createApprovalsEventBus.
export function createMailboxEventBus(): MailboxEventBus {
  const listenersByPrincipal = new Map<string, Set<MailboxEventListener>>();

  return {
    publish(principalId, event) {
      const listeners = listenersByPrincipal.get(principalId);
      if (listeners === undefined) return;
      for (const listener of listeners) listener(event);
    },
    subscribe(principalId, listener) {
      let listeners = listenersByPrincipal.get(principalId);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByPrincipal.set(principalId, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = listenersByPrincipal.get(principalId);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listenersByPrincipal.delete(principalId);
      };
    },
  };
}
