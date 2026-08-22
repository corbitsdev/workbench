import { describe, test, expect } from "bun:test";

import { runWithConcurrency } from "./concurrency";

describe("runWithConcurrency", () => {
  test("runs every item and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];

    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(item);
      inFlight -= 1;
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("isolates a failing item: the rest still complete and the failure is reported per item", async () => {
    const completed: number[] = [];
    const failures = await runWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
      completed.push(item);
    });

    expect(completed.sort()).toEqual([1, 3]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.item).toBe(2);
    expect((failures[0]?.error as Error).message).toBe("boom");
  });

  test("an empty list resolves immediately with no failures", async () => {
    const failures = await runWithConcurrency(
      [] as number[],
      4,
      async () => {},
    );
    expect(failures).toEqual([]);
  });

  test("a limit larger than the item count still runs everything exactly once", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2], 10, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });
});
