import { describe, expect, test } from "bun:test";

import { createMemoryUsageStore } from "./store";
import {
  activityByDay,
  emptyOverallUsageSummary,
  summarizeUsage,
} from "./queries";

describe("summarizeUsage", () => {
  test("empty sink returns zero metrics, not null cost or NaN", async () => {
    const store = createMemoryUsageStore();
    const summary = await summarizeUsage(store, "tenant-acme");
    expect(summary).toEqual(emptyOverallUsageSummary());
    expect(summary.turns).toBe(0);
    expect(summary.costUsd).toBe(0);
    expect(summary.tokens.total).toBe(0);
    expect(summary.byModel).toEqual([]);
    expect(Number.isNaN(summary.costUsd)).toBe(false);
  });

  test("aggregates by model and overall with known rates", async () => {
    const store = createMemoryUsageStore([
      {
        model: "claude-sonnet",
        rates: {
          inputPerMTok: 3,
          outputPerMTok: 15,
          cacheReadPerMTok: 0.3,
          cacheWritePerMTok: 3.75,
          thinkingPerMTok: 15,
        },
      },
    ]);

    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "claude-sonnet",
      tokens: {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T12:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t2",
      model: "claude-sonnet",
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1_000_000,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T13:00:00Z"),
    });

    const summary = await summarizeUsage(store, "tenant-acme");
    expect(summary.turns).toBe(2);
    expect(summary.tokens.input).toBe(1_000_000);
    expect(summary.tokens.output).toBe(1_000_000);
    expect(summary.costUsd).toBe(3 + 15);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe("claude-sonnet");
  });

  test("unknown model rate yields null cost, not zero", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "mystery-model",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const summary = await summarizeUsage(store, "tenant-acme");
    expect(summary.costUsd).toBeNull();
    expect(summary.byModel[0]?.costUsd).toBeNull();
    expect(summary.tokens.input).toBe(100);
  });

  test("tenant isolation — other tenants do not appear", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-other",
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: {
        input: 99,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const summary = await summarizeUsage(store, "tenant-acme");
    expect(summary.turns).toBe(1);
    expect(summary.tokens.input).toBe(1);
  });
});

describe("activityByDay", () => {
  test("empty sink returns empty series (no fabricated peaks)", async () => {
    const store = createMemoryUsageStore();
    const days = await activityByDay(store, "tenant-acme");
    expect(days).toEqual([]);
  });

  test("buckets by UTC day", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T23:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t2",
      model: "m",
      tokens: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
      recordedAt: new Date("2026-08-02T01:00:00Z"),
    });

    const days = await activityByDay(store, "tenant-acme");
    expect(days).toEqual([
      { day: "2026-08-01", turns: 1, tokens: 10 },
      { day: "2026-08-02", turns: 1, tokens: 5 },
    ]);
  });
});
