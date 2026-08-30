// Pure product rules for bulk inbox ops. Kept free of the DB so the
// mark-all-read / clear-done contracts are unit-testable without the
// platform tenant/principal tables the mailbox FKs require.

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

export interface BulkOperationResult {
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Apply `apply` to every item, one at a time, never letting one item's
 * failure abort the rest (CL-7207). Previously `mark-all-read` and
 * `clear-done` ran their per-item writes in a plain loop with no
 * per-item try/catch: a throw on item N left the handler throwing out of
 * the whole request — a 500 with items before N already mutated, item N
 * left in a new inconsistent state, and everything after N untouched, with
 * no way for the caller to tell how far it got. Catching per item instead
 * means a transient failure on one row costs that one row, not the rest of
 * the inbox, and the caller gets back exactly how many succeeded and how
 * many didn't rather than an opaque 500.
 */
export async function runBulkOperation<T>(
  items: readonly T[],
  apply: (item: T) => Promise<void>,
  onError?: (item: T, error: unknown) => void,
): Promise<BulkOperationResult> {
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await apply(item);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      onError?.(item, error);
    }
  }
  return { succeeded, failed };
}
