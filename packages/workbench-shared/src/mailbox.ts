import { type } from "arktype";
import { deepLink } from "./deep-link";

// A typed entity reference carried by a mailbox message — the structured
// backing for the reading pane's "Related" action row. `artifact`,
// `workflow_run`, `task`, and `mail` refs carry a Workbench entity id (resolved
// to an in-app route via the deepLink helper); `linear` and `url` refs carry a
// full external URL in `ref`. `label` is the human-facing action text.
export const MailboxRefSchema = type({
  kind: "'artifact' | 'workflow_run' | 'task' | 'mail' | 'linear' | 'url'",
  ref: "string",
  "label?": "string",
});
export type MailboxRef = typeof MailboxRefSchema.infer;

// The /me/inbox contract: one durable principal_mailbox row, decoded for
// display. `read` reflects the row's read_at marker; `date` and timestamps
// are ISO strings on the wire. `from` is the RFC From header value (usually
// the sender's mailbox address); `fromDisplay` is a tenant-resolved label
// when the hub can map the address to an agent or user name.
export const MailboxMessage = type({
  id: "string",
  from: "string",
  "fromDisplay?": "string",
  to: "string[]",
  "subject?": "string",
  date: "string",
  messageId: "string",
  "snippet?": "string",
  read: "boolean",
  // Structured entity references for the "Related" action row. Absent on
  // legacy rows and any mail whose creator emits none; the read path only sets
  // it when the stored frame carries a non-empty ref list.
  "refs?": MailboxRefSchema.array(),
});
export type MailboxMessage = typeof MailboxMessage.infer;

// The /me/inbox/:id contract: the list fields plus the full text body
// extracted from the stored raw frame. An unparseable frame degrades to an
// empty body rather than failing the read.
export const MailboxMessageDetail = MailboxMessage.and(
  type({ body: "string" }),
);
export type MailboxMessageDetail = typeof MailboxMessageDetail.infer;

// One keyset-paginated page of the caller's inbox, newest first, with an opaque
// cursor for the next page when one exists.
export const MailboxListResponse = type({
  messages: MailboxMessage.array(),
  "nextCursor?": "string",
});
export type MailboxListResponse = typeof MailboxListResponse.infer;

/**
 * The target a "Related" ref opens. Internal kinds resolve through the
 * deepLink helper (relative for react-router, or absolute when `baseUrl` is
 * given); `linear`/`url` refs already carry a full URL, returned as-is.
 */
export function mailboxRefHref(ref: MailboxRef, baseUrl?: string): string {
  switch (ref.kind) {
    case "artifact":
    case "workflow_run":
    case "task":
    case "mail":
      return deepLink(ref.kind, ref.ref, baseUrl);
    case "linear":
    case "url":
      return ref.ref;
  }
}

/** True when the ref opens an external URL in a new tab, not an in-app route. */
export function isExternalMailboxRef(ref: MailboxRef): boolean {
  return ref.kind === "linear" || ref.kind === "url";
}

export function mailboxSenderLabel(
  message: Pick<MailboxMessage, "from" | "fromDisplay">,
): string {
  return message.fromDisplay ?? message.from;
}
