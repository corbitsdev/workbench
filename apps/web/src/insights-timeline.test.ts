import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import { bucketRunsByDay } from "./insights-timeline";

function run(createdAt: string, id?: string): WorkflowRun {
  return {
    id: id ?? createdAt,
    tenantId: "t1",
    tenantName: "Bench",
    definitionId: "def",
    definitionName: "research-brief",
    address: "addr",
    status: "running",
    createdAt,
  };
}

// Fixed "now" at 2026-01-15T18:00Z so day math is deterministic regardless of
// when the suite runs.
const NOW = new Date("2026-01-15T18:00:00.000Z");

describe("bucketRunsByDay", () => {
  test("emits one bucket per day, oldest first, with zero counts", () => {
    const buckets = bucketRunsByDay([], 3, NOW);
    expect(buckets).toHaveLength(3);
    // Oldest first: Jan 13, Jan 14, Jan 15 (UTC days, since NOW is UTC).
    expect(buckets[0].key).toBe("2026-01-13");
    expect(buckets[1].key).toBe("2026-01-14");
    expect(buckets[2].key).toBe("2026-01-15");
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  test("counts runs into the correct UTC day bucket", () => {
    const buckets = bucketRunsByDay(
      [
        run("2026-01-15T01:00:00.000Z"),
        run("2026-01-15T22:00:00.000Z"),
        run("2026-01-14T12:00:00.000Z"),
        run("2026-01-10T12:00:00.000Z"), // outside the window — dropped
      ],
      3,
      NOW,
    );
    expect(buckets.map((b) => b.count)).toEqual([0, 1, 2]);
  });

  test("ignores runs older than the window", () => {
    const buckets = bucketRunsByDay([run("2025-12-01T00:00:00.000Z")], 7, NOW);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });

  test("labels are unique within the window", () => {
    const buckets = bucketRunsByDay([run("2026-01-15T01:00:00.000Z")], 5, NOW);
    const labels = buckets.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("defaults `days` to a sane default when omitted", () => {
    const buckets = bucketRunsByDay([], 7, NOW);
    expect(buckets).toHaveLength(7);
  });
});
