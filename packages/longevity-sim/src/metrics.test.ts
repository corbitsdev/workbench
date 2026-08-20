import { describe, expect, test } from "bun:test";
import { findKnees, percentile, type CheckpointRecord } from "./metrics";

function checkpoint(overrides: Partial<CheckpointRecord>): CheckpointRecord {
  return {
    atMessages: 0,
    wallClockMs: 0,
    sendLatencyP50Ms: 0,
    sendLatencyP95Ms: 0,
    sendLatencyMaxMs: 0,
    turnLatencyP50Ms: 0,
    turnLatencyP95Ms: 0,
    turnCount: 0,
    firstTokenP50Ms: 0,
    dbSizeBytes: 0,
    messagePageMs: 0,
    messagePageDeepMs: 0,
    workbenchListMs: 0,
    hubRssBytes: 0,
    sidecarRssBytes: 0,
    collectorFailures: 0,
    routineFiresTotal: 0,
    routineFiresAccepted: 0,
    sendFailures: 0,
    turnFailures: 0,
    ...overrides,
  };
}

describe("percentile", () => {
  test("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  test("returns the single value for a one-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  test("p50 of an even-length sorted array picks the lower-middle value", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  test("p95 picks a high value near the tail", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });

  test("is order-independent", () => {
    const sorted = [1, 2, 3, 4, 5];
    const shuffled = [3, 1, 5, 2, 4];
    expect(percentile(sorted, 50)).toBe(percentile(shuffled, 50));
  });
});

describe("findKnees", () => {
  test("finds no knees on a flat metric", () => {
    const checkpoints = [
      checkpoint({ atMessages: 0, sendLatencyP50Ms: 100 }),
      checkpoint({ atMessages: 100, sendLatencyP50Ms: 105 }),
      checkpoint({ atMessages: 200, sendLatencyP50Ms: 98 }),
    ];
    expect(findKnees(checkpoints)).toEqual([]);
  });

  test("finds a knee at the first checkpoint crossing the ratio threshold", () => {
    const checkpoints = [
      checkpoint({ atMessages: 0, sendLatencyP50Ms: 50 }),
      checkpoint({ atMessages: 100, sendLatencyP50Ms: 80 }),
      checkpoint({ atMessages: 200, sendLatencyP50Ms: 200 }),
      checkpoint({ atMessages: 300, sendLatencyP50Ms: 400 }),
    ];
    const knees = findKnees(checkpoints);
    const sendKnee = knees.find((knee) => knee.metric === "sendLatencyP50Ms");
    expect(sendKnee).toBeDefined();
    expect(sendKnee?.atMessages).toBe(200);
    expect(sendKnee?.baseline).toBe(50);
  });

  test("uses the first nonzero checkpoint as baseline, skipping leading zeros", () => {
    const checkpoints = [
      checkpoint({ atMessages: 0, dbSizeBytes: 0 }),
      checkpoint({ atMessages: 100, dbSizeBytes: 1000 }),
      checkpoint({ atMessages: 200, dbSizeBytes: 3500 }),
    ];
    const knees = findKnees(checkpoints);
    const dbKnee = knees.find((knee) => knee.metric === "dbSizeBytes");
    expect(dbKnee).toBeDefined();
    expect(dbKnee?.baseline).toBe(1000);
    expect(dbKnee?.atMessages).toBe(200);
  });

  test("respects a custom ratio threshold", () => {
    const checkpoints = [
      checkpoint({ atMessages: 0, workbenchListMs: 10 }),
      checkpoint({ atMessages: 100, workbenchListMs: 15 }),
    ];
    expect(findKnees(checkpoints, { ratioThreshold: 3 })).toEqual([]);
    const knees = findKnees(checkpoints, { ratioThreshold: 1.4 });
    expect(knees.some((knee) => knee.metric === "workbenchListMs")).toBe(true);
  });

  test("ignores a metric that never becomes nonzero", () => {
    const checkpoints = [
      checkpoint({ atMessages: 0, hubRssBytes: 0 }),
      checkpoint({ atMessages: 100, hubRssBytes: 0 }),
    ];
    expect(
      findKnees(checkpoints).some((knee) => knee.metric === "hubRssBytes"),
    ).toBe(false);
  });
});
