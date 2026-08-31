import { describe, expect, test } from "bun:test";

import { createRunCreateRateLimiter, RATE_WINDOW_MS } from "./workflow-routes";

describe("createRunCreateRateLimiter", () => {
  test("evicts an idle run's entry instead of holding it for the process lifetime", () => {
    let clock = 0;
    const limiter = createRunCreateRateLimiter(3, () => clock);

    for (let i = 0; i < 500; i++) {
      limiter.allow(`run-${i}`);
    }
    expect(limiter.trackedRunCount).toBe(500);

    // Every one of those runs has gone idle for a full window: their
    // entries should be reclaimed, not carried forever.
    clock += RATE_WINDOW_MS;
    limiter.allow("run-fresh");
    expect(limiter.trackedRunCount).toBe(1);
  });

  test("a caller cannot exceed the rate by exploiting eviction timing", () => {
    let clock = 0;
    const maxPerWindow = 3;
    const limiter = createRunCreateRateLimiter(maxPerWindow, () => clock);
    const runId = "run-under-test";

    for (let i = 0; i < maxPerWindow; i++) {
      expect(limiter.allow(runId)).toBe(true);
    }
    expect(limiter.allow(runId)).toBe(false);

    // Advance right up to (but not past) the window boundary: the
    // entry's TTL must not have lapsed yet, so the earlier timestamps
    // are still counted and the limit still holds.
    clock += RATE_WINDOW_MS - 1;
    expect(limiter.allow(runId)).toBe(false);

    // Advance past the window: the original timestamps are now stale
    // and a fresh budget opens up, which is the intended sliding-window
    // behavior rather than a leak of the earlier eviction.
    clock += 1;
    for (let i = 0; i < maxPerWindow; i++) {
      expect(limiter.allow(runId)).toBe(true);
    }
    expect(limiter.allow(runId)).toBe(false);
  });

  test("does not let concurrently active runs go unbounded by other idle ones", () => {
    let clock = 0;
    const limiter = createRunCreateRateLimiter(3, () => clock);

    // A burst of one-shot runs, each idle immediately after.
    for (let i = 0; i < 200; i++) {
      limiter.allow(`idle-run-${i}`);
      clock += 1;
    }

    // One run stays continuously active, well past when the idle runs'
    // entries should have expired.
    clock += RATE_WINDOW_MS;
    const activeRunId = "active-run";
    limiter.allow(activeRunId);

    expect(limiter.trackedRunCount).toBe(1);
  });
});
