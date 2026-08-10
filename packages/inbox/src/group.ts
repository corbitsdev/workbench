// Three product groups over mailbox messages. Classification is stamped at
// write time when known; otherwise the group is derived from refs so rows
// delivered before this package still land in the right column.

export const INBOX_GROUPS = ["action", "mention", "delivery"] as const;
export type InboxGroup = (typeof INBOX_GROUPS)[number];

export function isInboxGroup(value: string): value is InboxGroup {
  return (INBOX_GROUPS as readonly string[]).includes(value);
}

/**
 * Map a message's classification + refs onto one of the three product groups.
 * Order is deliberate: an explicit classification wins; otherwise an approval
 * ref means "needs a decision", a thread ref means "someone mentioned you",
 * and everything else is a delivery (routine output, run failure, …).
 */
export function inboxGroupOf(message: {
  classification?: string | undefined;
  refs?: readonly { kind: string }[] | undefined;
}): InboxGroup {
  if (
    message.classification === "action" ||
    message.classification === "mention" ||
    message.classification === "delivery"
  ) {
    return message.classification;
  }
  const kinds = new Set((message.refs ?? []).map((ref) => ref.kind));
  if (kinds.has("approval")) return "action";
  if (kinds.has("thread")) return "mention";
  return "delivery";
}

/**
 * Classification to stamp on a new write from the item's refs, so later
 * list filters (`?classification=`) hit the product group without re-deriving.
 */
export function classificationFromRefs(
  refs: readonly { kind: string }[] | undefined,
): InboxGroup {
  return inboxGroupOf({ refs });
}
