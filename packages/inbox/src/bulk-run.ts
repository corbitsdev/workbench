// Server-only per-item bulk runner. Lives apart from `./bulk` so the
// eligibility helpers stay browser-safe (`./client` re-exports them)
// while this catch path can call `reportError` without pulling
// `@intx/log` into a browser bundle.

import { reportError } from "@corbits/error-sink";

export interface BulkOperationResult {
  readonly succeeded: number;
  readonly failed: number;
}

/** Optional reportError context and per-item hook for a bulk failure. */
export type BulkOperationOptions<T> = {
  readonly onError?: (item: T, error: unknown) => void;
  readonly operation?: string;
  readonly tenantId?: string;
  readonly extra?: Record<string, unknown>;
  readonly extraFor?: (item: T) => Record<string, unknown>;
};

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
  options?: BulkOperationOptions<T>,
): Promise<BulkOperationResult> {
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await apply(item);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const extra = options?.extraFor?.(item) ?? options?.extra;
      reportError(error, {
        operation: options?.operation ?? "inbox.bulk",
        ...(options?.tenantId !== undefined
          ? { tenantId: options.tenantId }
          : {}),
        ...(extra !== undefined ? { extra } : {}),
      });
      options?.onError?.(item, error);
    }
  }
  return { succeeded, failed };
}
