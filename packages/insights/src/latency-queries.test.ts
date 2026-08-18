import { describe, expect, test } from "bun:test";

import { createMemoryTurnLatencyStore } from "./latency-store";
import { percentile, summarizeLatency } from "./queries";

const BASE = new Date("2026-08-01T00:00:00Z").getTime();

function ms(offset: number): Date {
  return new Date(BASE + offset);
}

describe("percentile", () => {
  test("null on empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test("nearest-rank p50/p95 over a sorted array", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
  });
});

describe("summarizeLatency", () => {
  test("no rows: every stage is null with zero samples", async () => {
    const store = createMemoryTurnLatencyStore();
    const summary = await summarizeLatency(store, ["tenant-acme"]);
    expect(summary.total).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(summary.toReactorStart).toEqual({
      p50Ms: null,
      p95Ms: null,
      samples: 0,
    });
  });

  test("a warm-session row (no reactorStartAt) skips that stage only", async () => {
    const store = createMemoryTurnLatencyStore();
    await store.insertLatency({
      id: "id-1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      messageId: "m1",
      messageRunId: "r1",
      status: "completed",
      receivedAt: ms(0),
      reactorStartAt: null,
      inferenceStartAt: ms(500),
      firstTokenAt: ms(2_000),
      replyPostedAt: ms(4_000),
    });

    const summary = await summarizeLatency(store, ["tenant-acme"]);
    expect(summary.toReactorStart.samples).toBe(0);
    expect(summary.toInferenceStart.samples).toBe(1);
    expect(summary.toInferenceStart.p50Ms).toBe(500);
    expect(summary.toFirstToken.p50Ms).toBe(1_500);
    expect(summary.toReplyPosted.p50Ms).toBe(2_000);
    expect(summary.total.p50Ms).toBe(4_000);
  });

  test("p50/p95 over several rows", async () => {
    const store = createMemoryTurnLatencyStore();
    const totals = [1_000, 2_000, 3_000, 4_000, 10_000];
    for (const [i, totalMs] of totals.entries()) {
      await store.insertLatency({
        id: `id-${i}`,
        tenantId: "tenant-acme",
        sessionId: "s1",
        messageId: `m${i}`,
        messageRunId: `r${i}`,
        status: "completed",
        receivedAt: ms(0),
        reactorStartAt: null,
        inferenceStartAt: null,
        firstTokenAt: null,
        replyPostedAt: ms(totalMs),
      });
    }

    const summary = await summarizeLatency(store, ["tenant-acme"]);
    expect(summary.total.samples).toBe(5);
    expect(summary.total.p50Ms).toBe(3_000);
    expect(summary.total.p95Ms).toBe(10_000);
  });

  test("scopes to the requested tenants only", async () => {
    const store = createMemoryTurnLatencyStore();
    await store.insertLatency({
      id: "id-a",
      tenantId: "workbench-a",
      sessionId: "s1",
      messageId: "m1",
      messageRunId: "r1",
      status: "completed",
      receivedAt: ms(0),
      reactorStartAt: null,
      inferenceStartAt: null,
      firstTokenAt: null,
      replyPostedAt: ms(1_000),
    });
    await store.insertLatency({
      id: "id-b",
      tenantId: "workbench-b",
      sessionId: "s2",
      messageId: "m2",
      messageRunId: "r2",
      status: "completed",
      receivedAt: ms(0),
      reactorStartAt: null,
      inferenceStartAt: null,
      firstTokenAt: null,
      replyPostedAt: ms(9_000),
    });

    const summary = await summarizeLatency(store, ["workbench-a"]);
    expect(summary.total.samples).toBe(1);
    expect(summary.total.p50Ms).toBe(1_000);
  });
});
