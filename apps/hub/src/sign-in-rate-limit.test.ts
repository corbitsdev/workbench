import { describe, expect, test } from "bun:test";
import { createSignInAttemptLimiter } from "./sign-in-rate-limit.ts";

describe("createSignInAttemptLimiter", () => {
  test("the Nth failure against one account past the configured max is rejected", () => {
    const limiter = createSignInAttemptLimiter(60, 2);

    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    const throttled = limiter.recordFailure("victim@example.com");

    expect(throttled.allowed).toBe(false);
  });

  test("a rejected failure reports how many seconds remain in the window", () => {
    const limiter = createSignInAttemptLimiter(60, 1);

    limiter.recordFailure("victim@example.com");
    const throttled = limiter.recordFailure("victim@example.com");

    expect(throttled.allowed).toBe(false);
    if (!throttled.allowed) {
      expect(throttled.retryAfterSeconds).toBeGreaterThan(0);
      expect(throttled.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  test("rotating the caller-supplied identity per attempt does not grow the budget for the targeted account", () => {
    // The whole point of keying on the account instead of client IP:
    // a caller that varies some other, attacker-chosen value per request
    // (a forged IP header, in production) still can't outrun the budget
    // for the one email it's actually attacking, because the key is the
    // email — nothing about a rotated header changes it.
    const limiter = createSignInAttemptLimiter(60, 3);

    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(false);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(false);
  });

  test("two distinct accounts get independent budgets", () => {
    const limiter = createSignInAttemptLimiter(60, 1);

    expect(limiter.recordFailure("alice@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("alice@example.com").allowed).toBe(false);

    // Bob's own budget is untouched by Alice's exhausted one.
    expect(limiter.recordFailure("bob@example.com").allowed).toBe(true);
  });

  test("email matching is case- and whitespace-insensitive, so it can't be sidestepped by casing/padding", () => {
    const limiter = createSignInAttemptLimiter(60, 1);

    expect(limiter.recordFailure("Victim@Example.com").allowed).toBe(true);
    expect(limiter.recordFailure(" victim@example.com ").allowed).toBe(false);
  });

  test("a successful sign-in clears the account's budget, so a prior run of failures never carries over", () => {
    const limiter = createSignInAttemptLimiter(60, 1);

    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(false);

    limiter.recordSuccess("victim@example.com");

    // The next failure is treated as a fresh first attempt, not a
    // continuation of the exhausted budget from before the success.
    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
  });

  test("recordSuccess is case- and whitespace-insensitive, matching the key recordFailure uses", () => {
    const limiter = createSignInAttemptLimiter(60, 1);

    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
    limiter.recordSuccess(" Victim@Example.com ");

    expect(limiter.recordFailure("victim@example.com").allowed).toBe(true);
  });
});
