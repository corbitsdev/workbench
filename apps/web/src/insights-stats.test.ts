import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import { computeInsightsStats } from "./insights-stats";
import type { Routine } from "./routines-api";

function run(
  partial: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "status">,
): WorkflowRun {
  return {
    tenantId: "t1",
    tenantName: "Bench",
    definitionId: "def",
    definitionName: partial.definitionName ?? "research-brief",
    address: "addr",
    createdAt: partial.createdAt ?? "2026-01-02T00:00:00.000Z",
    ...partial,
  };
}

function routine(
  partial: Partial<Routine> & Pick<Routine, "id" | "enabled">,
): Routine {
  return {
    name: "Daily dig",
    definitionId: "def",
    trigger: { kind: "interval", unit: "hours", every: 24 },
    scope: "bench",
    input: {},
    deliveryChannelId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("computeInsightsStats", () => {
  test("counts purposeful runs by status and drops channel hosts", () => {
    const stats = computeInsightsStats(
      [
        run({ id: "1", status: "running", createdAt: "2026-01-03T00:00:00.000Z" }),
        run({ id: "2", status: "error", createdAt: "2026-01-02T00:00:00.000Z" }),
        run({ id: "3", status: "stopped", createdAt: "2026-01-01T00:00:00.000Z" }),
        run({
          id: "host",
          status: "running",
          definitionName: "ins-cd03d8e3",
          createdAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
      [routine({ id: "r1", enabled: true }), routine({ id: "r2", enabled: false })],
    );

    expect(stats.totalRuns).toBe(3);
    expect(stats.running).toBe(1);
    expect(stats.errored).toBe(1);
    expect(stats.stopped).toBe(1);
    expect(stats.routineCount).toBe(2);
    expect(stats.enabledRoutines).toBe(1);
    expect(stats.recentRuns.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  test("limits recent runs", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({
        id: String(i),
        status: "deployed",
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const stats = computeInsightsStats(runs, [], 2);
    expect(stats.recentRuns).toHaveLength(2);
    expect(stats.deployed).toBe(5);
  });
});
