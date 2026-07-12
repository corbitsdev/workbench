import { type } from "arktype";
import { createKeyedEventBus } from "./keyed-event-bus";

// A change NOTIFICATION, never the approval data itself. The payload carries
// only the tenant it belongs to, an optional session for client-side filtering,
// and whether an approval was created or resolved. Clients react by refetching
// the ownership-scoped list endpoint — sensitive tool-call context never rides
// this broadcast channel.
export const ApprovalEventSchema = type({
  tenantId: "string",
  sessionId: "string | null",
  kind: "'created' | 'resolved'",
});
export type ApprovalEvent = typeof ApprovalEventSchema.infer;

type ApprovalEventListener = (event: ApprovalEvent) => void;

export interface ApprovalsEventBus {
  publish(event: ApprovalEvent): void;
  subscribe(tenantId: string, listener: ApprovalEventListener): () => void;
}

// In-process pub/sub keyed by tenantId. A stateful resource: construct it once
// in index.ts and inject the same instance into both approvals routers so an
// insert in the internal router reaches a subscriber opened on the v1 router.
// Single-hub-replica scope — the SSE subscribers and the mutation emitters must
// live in the same process for delivery (same assumption as the workflow
// reconcilers).
export function createApprovalsEventBus(): ApprovalsEventBus {
  const bus = createKeyedEventBus<ApprovalEvent>();
  return {
    publish: (event) => bus.publish(event.tenantId, event),
    subscribe: (tenantId, listener) => bus.subscribe(tenantId, listener),
  };
}
