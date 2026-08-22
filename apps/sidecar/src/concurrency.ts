export interface ConcurrencyFailure<T> {
  item: T;
  error: unknown;
}

/**
 * Runs `fn` over every item with at most `limit` in flight at once. Each
 * item's failure is caught and returned rather than thrown, so one bad
 * item never stops the rest of the batch from running -- the same
 * per-item isolation a serial `for` loop with a `try`/`catch` gives, just
 * bounded-parallel instead of one-at-a-time.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<ConcurrencyFailure<T>[]> {
  const failures: ConcurrencyFailure<T>[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as T;
      try {
        await fn(item);
      } catch (error) {
        failures.push({ item, error });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return failures;
}
