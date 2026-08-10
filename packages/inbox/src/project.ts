// Project a mailbox message into the product InboxItem shape the shell and
// mock consume. Keeps the mailbox package's wire shape internal.

import type { MailboxMessage, MailboxMessageDetail } from "@corbits/mailbox";
import { type } from "arktype";

import { inboxGroupOf, type InboxGroup } from "./group";

export const InboxItemSchema = type({
  id: "string",
  group: "'action' | 'mention' | 'delivery'",
  from: "string",
  "fromDisplay?": "string",
  "subject?": "string",
  date: "string",
  read: "boolean",
  status: "'open' | 'done' | 'snoozed'",
  "snippet?": "string",
  "refs?": type({
    kind: "string",
    id: "string",
    "label?": "string",
  }).array(),
  "priority?": "string",
  "assignee?": "string",
});
export type InboxItem = typeof InboxItemSchema.infer;

export const InboxItemDetailSchema = InboxItemSchema.and({
  body: "string",
});
export type InboxItemDetail = typeof InboxItemDetailSchema.infer;

export const InboxCountsSchema = type({
  action: "number",
  mention: "number",
  delivery: "number",
  open: "number",
});
export type InboxCounts = typeof InboxCountsSchema.infer;

function projectStatus(
  status: string | undefined,
): "open" | "done" | "snoozed" {
  if (status === "done" || status === "snoozed") return status;
  return "open";
}

export function projectInboxItem(message: MailboxMessage): InboxItem {
  const group: InboxGroup = inboxGroupOf(message);
  const item: InboxItem = {
    id: message.id,
    group,
    from: message.from,
    date: message.date,
    read: message.read,
    status: projectStatus(message.status),
  };
  if (message.fromDisplay !== undefined) item.fromDisplay = message.fromDisplay;
  if (message.subject !== undefined) item.subject = message.subject;
  if (message.snippet !== undefined) item.snippet = message.snippet;
  if (message.refs !== undefined) item.refs = [...message.refs];
  if (message.priority !== undefined) item.priority = message.priority;
  if (message.assignee !== undefined) item.assignee = message.assignee;
  return item;
}

export function projectInboxItemDetail(
  message: MailboxMessageDetail,
): InboxItemDetail {
  return {
    ...projectInboxItem(message),
    body: message.body,
  };
}
