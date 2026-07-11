import { type } from "arktype";

// The /me/inbox contract: one durable principal_mailbox row, decoded for
// display. `read` reflects the row's read_at marker; `date` and timestamps
// are ISO strings on the wire.
export const MailboxMessage = type({
  id: "string",
  from: "string",
  to: "string[]",
  "subject?": "string",
  date: "string",
  messageId: "string",
  "snippet?": "string",
  read: "boolean",
});
export type MailboxMessage = typeof MailboxMessage.infer;

export const MailboxListResponse = type({
  messages: MailboxMessage.array(),
});
export type MailboxListResponse = typeof MailboxListResponse.infer;
