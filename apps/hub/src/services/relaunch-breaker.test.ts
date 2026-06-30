import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  isInRelaunchCooldown,
  resetRelaunchBreaker,
  runDedupedRelaunch,
  setRelaunchBreakerClock,
} from "./relaunch-breaker";

afterEach(() => {
  resetRelaunchBreaker();
});

describe("runDedupedRelaunch — in-flight dedup", () => {
  it("coalesces concurrent calls onto a single launch", async () => {
    let resolveLaunch: () => void = () => {};
    const launch = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveLaunch = resolve;
        }),
    );

    const first = runDedupedRelaunch("ins-1", launch);
    const second = runDedupedRelaunch("ins-1", launch);

    expect(launch).toHaveBeenCalledTimes(1);

    resolveLaunch();
    await Promise.all([first, second]);
  });

  it("allows a fresh launch after the prior one settles", async () => {
    const launch = mock(() => Promise.resolve());

    await runDedupedRelaunch("ins-1", launch);
    await runDedupedRelaunch("ins-1", launch);

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("keeps dedup keyed per instance", async () => {
    let resolveA: () => void = () => {};
    const launchA = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    const launchB = mock(() => Promise.resolve());

    const a = runDedupedRelaunch("ins-A", launchA);
    await runDedupedRelaunch("ins-B", launchB);

    expect(launchA).toHaveBeenCalledTimes(1);
    expect(launchB).toHaveBeenCalledTimes(1);

    resolveA();
    await a;
  });
});

describe("runDedupedRelaunch — failure cooldown", () => {
  it("suppresses repeated launches during the cooldown window", async () => {
    let nowMs = 1_000_000;
    setRelaunchBreakerClock(() => nowMs);
    const launch = mock(() => Promise.reject(new Error("launch boom")));

    // First attempt actually launches and re-throws the cause.
    await expect(runDedupedRelaunch("ins-1", launch)).rejects.toThrow(
      "launch boom",
    );
    expect(launch).toHaveBeenCalledTimes(1);

    // Within the cooldown window: every subsequent poll is suppressed, no relaunch.
    nowMs += 1_000;
    await runDedupedRelaunch("ins-1", launch);
    nowMs += 5_000;
    await runDedupedRelaunch("ins-1", launch);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("re-attempts once the cooldown elapses", async () => {
    let nowMs = 2_000_000;
    setRelaunchBreakerClock(() => nowMs);
    const launch = mock(() => Promise.reject(new Error("launch boom")));

    await expect(runDedupedRelaunch("ins-1", launch)).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(1);

    // Advance past the 30s base cooldown — a re-attempt is allowed.
    nowMs += 30_000;
    await expect(runDedupedRelaunch("ins-1", launch)).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("bounds attempts across many polls while a launch keeps failing", async () => {
    let nowMs = 3_000_000;
    setRelaunchBreakerClock(() => nowMs);
    const launch = mock(() => Promise.reject(new Error("launch boom")));

    let attempted = 0;
    // Simulate 200 client polls, 1s apart, over the full window.
    for (let i = 0; i < 200; i++) {
      nowMs += 1_000;
      await runDedupedRelaunch("ins-1", launch).catch(() => {});
      attempted = launch.mock.calls.length;
    }

    // 200s of polling spans only the 30s + 60s + 120s backoff tiers, so the
    // launch is invoked a small bounded number of times, not once-per-poll.
    expect(attempted).toBeGreaterThanOrEqual(1);
    expect(attempted).toBeLessThanOrEqual(5);
  });

  it("grows the cooldown exponentially with consecutive failures", async () => {
    let nowMs = 4_000_000;
    setRelaunchBreakerClock(() => nowMs);
    const launch = mock(() => Promise.reject(new Error("launch boom")));

    await runDedupedRelaunch("ins-1", launch).catch(() => {});
    // 29s in: still cooling (base is 30s).
    nowMs += 29_000;
    expect(isInRelaunchCooldown("ins-1")).toBe(true);
    nowMs += 1_000;
    expect(isInRelaunchCooldown("ins-1")).toBe(false);

    // Second failure → 60s cooldown.
    await runDedupedRelaunch("ins-1", launch).catch(() => {});
    nowMs += 59_000;
    expect(isInRelaunchCooldown("ins-1")).toBe(true);
    nowMs += 1_000;
    expect(isInRelaunchCooldown("ins-1")).toBe(false);
  });

  it("clears the cooldown after a successful launch", async () => {
    let nowMs = 5_000_000;
    setRelaunchBreakerClock(() => nowMs);

    const failing = mock(() => Promise.reject(new Error("boom")));
    await runDedupedRelaunch("ins-1", failing).catch(() => {});
    expect(isInRelaunchCooldown("ins-1")).toBe(true);

    nowMs += 30_000;
    const succeeding = mock(() => Promise.resolve());
    await runDedupedRelaunch("ins-1", succeeding);

    expect(isInRelaunchCooldown("ins-1")).toBe(false);
  });
});
