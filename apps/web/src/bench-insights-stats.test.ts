import { describe, expect, test } from "bun:test";

import type { InsightsRun } from "./insights-api";
import { computeBenchInsights, medianMs } from "./insights-stats";

const NOW = Date.parse("2026-09-10T12:00:00");

function run(id: string, createdAt: string, status: string, endedAt?: string): InsightsRun {
  return {
    id,
    definitionId: "def_a",
    definitionName: "brief",
    createdAt,
    status,
    ...(endedAt === undefined ? {} : { endedAt }),
  } as unknown as InsightsRun;
}

describe("medianMs", () => {
  test("averages the middle pair of an even set", () => {
    expect(medianMs([4, 1, 3, 2])).toBe(2.5);
    expect(medianMs([])).toBeNull();
  });
});

describe("computeBenchInsights", () => {
  test("windows, buckets by outcome and day, and takes median duration", () => {
    const stats = computeBenchInsights(
      [
        run("a", "2026-09-10T09:00:00", "completed", "2026-09-10T09:01:00"),
        run("b", "2026-09-10T10:00:00", "failed", "2026-09-10T10:03:00"),
        run("c", "2026-09-09T10:00:00", "completed", "2026-09-09T10:02:00"),
        run("old", "2026-08-01T10:00:00", "completed", "2026-08-01T10:02:00"),
      ],
      7,
      NOW,
    );
    expect(stats.total).toBe(3);
    expect(stats.ok).toBe(2);
    expect(stats.fail).toBe(1);
    expect(stats.medianMs).toBe(120_000);
    expect(stats.days.at(-1)).toMatchObject({ ok: 1, fail: 1 });
    expect(stats.days.at(-2)).toMatchObject({ ok: 1, fail: 0 });
    expect(stats.failures.map((r) => r.id)).toEqual(["b"]);
  });
});
