import { type } from "arktype";
import { deepLink, deepLinkKinds, type DeepLinkKind } from "./deep-link";

// The external ref kinds carry a full URL in `ref` and open in a new tab,
// rather than a Workbench entity id resolved through the deepLink helper.
export const externalRefKinds = ["linear", "url"] as const;
export type ExternalRefKind = (typeof externalRefKinds)[number];

// A typed entity reference carried by a mailbox message — the structured
// backing for the reading pane's "Related" action row. Internal kinds carry a
// Workbench entity id resolved to an in-app route via the deepLink helper; the
// internal kind union is derived from `deepLinkKinds` so the two can never
// drift. `linear` and `url` refs carry a full external URL in `ref`. `label`
// is the human-facing action text.
//
// VERSIONING CONSTRAINT: refs are persisted as a jsonb blob on
// principal_mailbox.refs and re-validated through this schema on read (a row
// that fails validation degrades to no refs, never a 500). A backward-
// incompatible change to this shape therefore silently DROPS refs from rows
// written under the old shape — treat any change to `kind`/`ref`/`label` as a
// data migration, not a free edit.
export const MailboxRefSchema = type({
  kind: type.enumerated(...deepLinkKinds, ...externalRefKinds),
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

const externalRefKindSet: ReadonlySet<string> = new Set(externalRefKinds);

/** True when the ref opens an external URL in a new tab, not an in-app route. */
export function isExternalMailboxRef(ref: MailboxRef): boolean {
  return externalRefKindSet.has(ref.kind);
}

// Narrows a ref's kind to the internal deepLink kinds — anything not in the
// external set. Kept as a predicate on the kind so `mailboxRefHref` can hand
// `deepLink` a `DeepLinkKind` without a cast.
function isInternalRefKind(kind: MailboxRef["kind"]): kind is DeepLinkKind {
  return !externalRefKindSet.has(kind);
}

/**
 * The target a "Related" ref opens. Internal kinds resolve through the
 * deepLink helper (relative for react-router, or absolute when `baseUrl` is
 * given); `linear`/`url` refs already carry a full URL, returned as-is.
 */
export function mailboxRefHref(ref: MailboxRef, baseUrl?: string): string {
  if (isInternalRefKind(ref.kind)) return deepLink(ref.kind, ref.ref, baseUrl);
  return ref.ref;
}

// The human-facing fallback label for a ref that carries no explicit `label`.
// Shared by both chip surfaces (reading pane and bell) so a raw enum kind is
// never rendered to the user, on either surface.
export function defaultRefLabel(ref: MailboxRef): string {
  switch (ref.kind) {
    case "artifact":
      return "Open artifact";
    case "workflow_run":
      return "Open run";
    case "task":
      return "Open task";
    case "mail":
      return "Open message";
    case "conversation":
      return "Open chat";
    case "linear":
      return "Open in Linear";
    case "url":
      return "Open link";
  }
}

// The subject prefix every Myra triage handoff is stamped with. Shared by the
// hub writer (mailbox-triage) and the Now feed's legacy collapse fallback so
// the two can never drift out of the exact string they must agree on.
export const TRIAGE_SUBJECT_PREFIX = "Myra triaged: ";

export function mailboxSenderLabel(
  message: Pick<MailboxMessage, "from" | "fromDisplay">,
): string {
  return message.fromDisplay ?? message.from;
}
