// Pure product rules for bulk inbox ops. Kept free of the DB so the
// mark-all-read / clear-done contracts are unit-testable without the
// platform tenant/principal tables the mailbox FKs require. Also kept
// free of `@corbits/error-sink` so `./client` can re-export the
// eligibility helpers without pulling `@intx/log` into a browser bundle.

import type { InboxItem } from "./project";

/**
 * Mentions and deliveries that are still open — never action items.
 * Action rows require an explicit decision and must not be bulk-cleared.
 */
export function itemsEligibleForMarkAllRead(
  items: readonly InboxItem[],
): InboxItem[] {
  return items.filter(
    (item) => item.group !== "action" && item.status === "open",
  );
}

/** Rows whose status is `done` — open and snoozed stay. */
export function itemsEligibleForClearDone(
  items: readonly InboxItem[],
): InboxItem[] {
  return items.filter((item) => item.status === "done");
}
