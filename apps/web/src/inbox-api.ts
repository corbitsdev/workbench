// Client for the product inbox mounted at `/api/tenants/:tenantId/inbox`:
// fetch composition only. Wire schemas (InboxItemSchema, ...) and group
// classification are already browser-safe and exported from the package
// root (`@corbits/inbox`'s "." export mixes them with server-only route/
// migration code, so a UI pulls them through the "./client" subpath
// instead — see packages/inbox/src/client.ts and its README). This app
// only adds the request plumbing and the `InboxFilterGroup` UI concept
// (`"all"` plus the package's three product groups), neither of which
// belongs in the domain package.

import { type } from "arktype";

import { ApiQueryError } from "@corbits/api-query";
import {
  InboxItemSchema,
  type InboxGroup,
  type InboxItem,
} from "@corbits/inbox/client";

export {
  InboxCountsSchema,
  InboxItemDetailSchema,
  InboxItemSchema,
  type InboxCounts,
  type InboxItem,
  type InboxItemDetail,
} from "@corbits/inbox/client";

export const InboxListSchema = type({
  items: InboxItemSchema.array(),
  "nextCursor?": "string",
});
export type InboxList = typeof InboxListSchema.infer;

export type InboxFilterGroup = "all" | InboxGroup;

/** The filter group a `/inbox[/...]` path selects. */
export function inboxFilterFromPath(path: string): InboxFilterGroup {
  const segment = path.replace(/^\/inbox\/?/, "").split("/")[0] ?? "";
  if (segment === "action" || segment === "mention" || segment === "delivery") {
    return segment;
  }
  return "all";
}

/** The path that selects a filter group. */
export function inboxPathForFilter(group: InboxFilterGroup): string {
  return group === "all" ? "/inbox" : `/inbox/${group}`;
}

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
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      path,
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

/** A task-result item's own task (`packages/notify`'s render.ts stamps a
 * `{ kind: "task", id: event.taskId }` ref alongside the run/artifact refs)
 * — the id a caller resolves into the full task record to read its prompt,
 * agent, and status ("Make this a routine" only applies once that status is
 * `done`). */
export function taskRefFromItem(
  item: Pick<InboxItem, "refs">,
): { id: string; label?: string } | null {
  if (item.refs === undefined) return null;
  const ref = item.refs.find((r) => r.kind === "task");
  if (ref === undefined) return null;
  return ref.label === undefined
    ? { id: ref.id }
    : { id: ref.id, label: ref.label };
}

/** Every Library artifact a task-result (or any other) item references —
 * each becomes a chip in the detail pane deep-linking into the Library. */
export function artifactRefsFromItem(
  item: Pick<InboxItem, "refs">,
): readonly { id: string; label?: string }[] {
  if (item.refs === undefined) return [];
  return item.refs
    .filter((r) => r.kind === "artifact")
    .map((r) =>
      r.label === undefined ? { id: r.id } : { id: r.id, label: r.label },
    );
}
