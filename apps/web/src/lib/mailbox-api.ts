// Live-delivery signal client for the caller's own mailbox. Served by the
// workbench hub's inbox router (createInboxRouter), mounted under
// /api/v1/me/inbox/events. Mirrors subscribeApprovals in approvals-api.ts:
// carries no mail content, only a change signal — the caller reacts by
// refetching GET /me/inbox.

import { type } from "arktype";
import { buildEventSourceUrl } from "./api";
import { subscribeSharedEventStream } from "./shared-event-stream";

export const MailboxEventSchema = type({
  type: "'mailbox'",
  id: "string",
});
export type MailboxEvent = typeof MailboxEventSchema.infer;

const MAILBOX_STREAM_EVENT = "mailbox";

/**
 * Subscribe to the caller's own mailbox delivery signals over SSE. Identity is
 * derived server-side from the authenticated session (BetterAuth), never a
 * path or query parameter. Shares one ref-counted EventSource per stream URL
 * (see shared-event-stream). Each valid event invokes `onEvent`; malformed
 * frames are dropped. `onError` fires once if the connection never opens
 * (terminal failure). Returns an unsubscribe function that closes the
 * connection when the last subscriber leaves.
 */
export function subscribeMailboxEvents(
  onEvent: (event: MailboxEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = buildEventSourceUrl("me/inbox/events");
  return subscribeSharedEventStream(
    url,
    MAILBOX_STREAM_EVENT,
    (raw) => {
      const parsed = MailboxEventSchema(raw);
      if (parsed instanceof type.errors) return;
      onEvent(parsed);
    },
    onError,
  );
}
