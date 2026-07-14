import { describe, expect, it } from "bun:test";
import { slidingWindowLimiter } from "./sliding-window";

describe("slidingWindowLimiter", () => {
  it("admits spawns up to the budget within the window", () => {
    const limiter = slidingWindowLimiter(2, 60_000, () => 1_000);
    expect(limiter.tryAcquire("t-1")).toBe(true);
    expect(limiter.tryAcquire("t-1")).toBe(true);
  });

  it("rejects once the budget is exhausted within the window", () => {
    const limiter = slidingWindowLimiter(2, 60_000, () => 1_000);
    limiter.tryAcquire("t-1");
    limiter.tryAcquire("t-1");
    expect(limiter.tryAcquire("t-1")).toBe(false);
  });

  it("slides the window: old spawns expire and free up budget", () => {
    let clock = 1_000;
    const limiter = slidingWindowLimiter(1, 60_000, () => clock);
    expect(limiter.tryAcquire("t-1")).toBe(true);
    expect(limiter.tryAcquire("t-1")).toBe(false);
    clock += 60_001;
    expect(limiter.tryAcquire("t-1")).toBe(true);
  });

  it("isolates budgets per key: one exhausted key does not affect another", () => {
    const limiter = slidingWindowLimiter(1, 60_000, () => 1_000);
    expect(limiter.tryAcquire("t-1")).toBe(true);
    expect(limiter.tryAcquire("t-1")).toBe(false);
    expect(limiter.tryAcquire("t-2")).toBe(true);
  });

  it("does not count a rejected attempt against the budget", () => {
    let clock = 1_000;
    const limiter = slidingWindowLimiter(1, 60_000, () => clock);
    expect(limiter.tryAcquire("t-1")).toBe(true);
    expect(limiter.tryAcquire("t-1")).toBe(false);
    clock += 60_001;
    expect(limiter.tryAcquire("t-1")).toBe(true);
    expect(limiter.tryAcquire("t-1")).toBe(false);
  });
});
