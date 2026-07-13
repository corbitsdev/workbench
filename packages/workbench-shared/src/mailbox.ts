import { type } from "arktype";

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

export function mailboxSenderLabel(
  message: Pick<MailboxMessage, "from" | "fromDisplay">,
): string {
  return message.fromDisplay ?? message.from;
}
