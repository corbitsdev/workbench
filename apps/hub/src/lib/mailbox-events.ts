import { type } from "arktype";
import { createKeyedEventBus } from "./keyed-event-bus";

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
// open connections (multiple tabs/devices) — every connection for that
// principal receives every publish, and disconnecting one never affects the
// others. Single-hub-replica scope, same assumption as createApprovalsEventBus.
export function createMailboxEventBus(): MailboxEventBus {
  const bus = createKeyedEventBus<MailboxEvent>();
  return {
    publish: (principalId, event) => bus.publish(principalId, event),
    subscribe: (principalId, listener) => bus.subscribe(principalId, listener),
  };
}
