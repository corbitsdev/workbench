import { type } from "arktype";

/** Inbox list views for GET /me/inbox?view= */
export const MailboxInboxView = type.enumerated(
  "all",
  "unread",
  "archived",
  "trash",
);
export type MailboxInboxView = typeof MailboxInboxView.infer;

export const MailboxBulkAction = type.enumerated(
  "mark_read",
  "mark_unread",
  "trash",
  "archive",
  "restore",
);
export type MailboxBulkAction = typeof MailboxBulkAction.infer;

export const MailboxBulkRequest = type({
  action: MailboxBulkAction,
  ids: "string[]>=1",
});
export type MailboxBulkRequest = typeof MailboxBulkRequest.infer;

export const MailboxBulkResponse = type({
  updated: "number",
  ids: "string[]",
});
export type MailboxBulkResponse = typeof MailboxBulkResponse.infer;

export const MailboxUnreadCountResponse = type({ unread: "number" });
export type MailboxUnreadCountResponse =
  typeof MailboxUnreadCountResponse.infer;