// Client for the product inbox mounted at
// `/api/tenants/:tenantId/inbox`. Schemas mirror packages/inbox projections.

import { type } from "arktype";

import { APIMutationError } from "./api";

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

export const InboxListSchema = type({
  items: InboxItemSchema.array(),
  "nextCursor?": "string",
});
export type InboxList = typeof InboxListSchema.infer;

export type InboxFilterGroup = "all" | "action" | "mention" | "delivery";

export function inboxListPath(
  tenantId: string,
  group: InboxFilterGroup,
): string {
  const base = `/api/tenants/${tenantId}/inbox`;
  if (group === "all") return `${base}?status=open`;
  return `${base}?status=open&group=${group}`;
}

export function inboxCountsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/inbox/counts`;
}

export function inboxDetailPath(tenantId: string, id: string): string {
  return `/api/tenants/${tenantId}/inbox/${id}`;
}

async function postInbox(path: string, body: unknown = {}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new APIMutationError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new APIMutationError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
}

export function markInboxItemDone(tenantId: string, id: string): Promise<void> {
  return postInbox(`/api/tenants/${tenantId}/inbox/${id}/done`);
}

export function snoozeInboxItem(tenantId: string, id: string): Promise<void> {
  return postInbox(`/api/tenants/${tenantId}/inbox/${id}/snooze`, {});
}

export function markAllInboxRead(tenantId: string): Promise<void> {
  return postInbox(`/api/tenants/${tenantId}/inbox/mark-all-read`);
}

export function clearDoneInbox(tenantId: string): Promise<void> {
  return postInbox(`/api/tenants/${tenantId}/inbox/clear-done`);
}

export function approvalIdFromItem(
  item: Pick<InboxItem, "group" | "refs">,
): string | null {
  if (item.group !== "action" || item.refs === undefined) return null;
  const ref = item.refs.find((r) => r.kind === "approval");
  return ref?.id ?? null;
}

export function runRefFromItem(
  item: Pick<InboxItem, "refs">,
): { id: string; label?: string } | null {
  if (item.refs === undefined) return null;
  const ref = item.refs.find(
    (r) => r.kind === "run" || r.kind === "workflow-run",
  );
  if (ref === undefined) return null;
  return ref.label === undefined
    ? { id: ref.id }
    : { id: ref.id, label: ref.label };
}

export function channelRefFromItem(
  item: Pick<InboxItem, "refs">,
): { id: string; label?: string } | null {
  if (item.refs === undefined) return null;
  const ref = item.refs.find((r) => r.kind === "channel");
  if (ref === undefined) return null;
  return ref.label === undefined
    ? { id: ref.id }
    : { id: ref.id, label: ref.label };
}
