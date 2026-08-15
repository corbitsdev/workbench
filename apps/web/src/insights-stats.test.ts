import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import {
  computeInsightsStats,
  computeTraceStats,
  filterRunsByCreatedAt,
  purposeRunsForInsights,
} from "./insights-stats";
import type { RunTraceSpan } from "./insights-api";
import type { Routine } from "./routines-api";

function span(
  partial: Partial<RunTraceSpan> & Pick<RunTraceSpan, "id">,
): RunTraceSpan {
  return {
    label: partial.id,
    kind: "tool",
    start: 0,
    end: 1000,
    durationMs: null,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "measured",
    ...partial,
  };
}

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
    consecutiveFailures: 0,
    deadLetteredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("computeInsightsStats", () => {
  test("counts purposeful runs by status and drops channel hosts", () => {
    const stats = computeInsightsStats(
      [
        run({
          id: "1",
          status: "running",
          createdAt: "2026-01-03T00:00:00.000Z",
        }),
        run({
          id: "2",
          status: "error",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        run({
          id: "3",
          status: "stopped",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        run({
          id: "host",
          status: "running",
          definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          createdAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
      [
        routine({ id: "r1", enabled: true }),
        routine({ id: "r2", enabled: false }),
      ],
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

describe("purposeRunsForInsights", () => {
  const channelHost = run({
    id: "host",
    status: "running",
    definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  });
  const invitedAgent = run({
    id: "ins_invited",
    status: "running",
    definitionName: "Researcher",
  });
  const deployment = run({ id: "ins_deployed", status: "running" });

  test("drops a channel-host run with no folded-run-id set given", () => {
    expect(purposeRunsForInsights([deployment, channelHost])).toEqual([
      deployment,
    ]);
  });

  test("drops an invited-agent run under a real definitionId when its id is in the folded-run-id set", () => {
    const result = purposeRunsForInsights(
      [deployment, invitedAgent],
      new Set([invitedAgent.id]),
    );
    expect(result).toEqual([deployment]);
  });

  test("leaves an ordinary top-level deployment run alone", () => {
    const result = purposeRunsForInsights(
      [deployment],
      new Set([invitedAgent.id]),
    );
    expect(result).toEqual([deployment]);
  });
});

describe("computeTraceStats", () => {
  test("returns null when spans are absent or empty", () => {
    expect(computeTraceStats(null)).toBeNull();
    expect(computeTraceStats([])).toBeNull();
  });

  test("derives steps, completed, failed, and duration from spans", () => {
    const stats = computeTraceStats([
      span({ id: "a", phase: "ok", start: 0, end: 500 }),
      span({ id: "b", phase: "failed", start: 200, end: 900 }),
      span({ id: "c", phase: "awaiting", start: 400, end: 1200 }),
    ]);
    expect(stats).toEqual({
      steps: 3,
      completed: 1,
      failed: 1,
      durationMs: 1200,
    });
  });
});

describe("filterRunsByCreatedAt", () => {
  const from = "2026-01-08T18:00:00.000Z";
  const to = "2026-01-15T18:00:00.000Z";

  test("keeps runs inside the inclusive window", () => {
    const filtered = filterRunsByCreatedAt(
      [
        run({
          id: "old",
          status: "stopped",
          createdAt: "2026-01-08T17:59:59.000Z",
        }),
        run({ id: "edge-from", status: "stopped", createdAt: from }),
        run({
          id: "mid",
          status: "running",
          createdAt: "2026-01-12T12:00:00.000Z",
        }),
        run({ id: "edge-to", status: "deployed", createdAt: to }),
        run({
          id: "future",
          status: "running",
          createdAt: "2026-01-15T18:00:01.000Z",
        }),
      ],
      from,
      to,
    );
    expect(filtered.map((r) => r.id)).toEqual(["edge-from", "mid", "edge-to"]);
  });

  test("drops invalid createdAt timestamps", () => {
    const filtered = filterRunsByCreatedAt(
      [
        run({ id: "bad", status: "stopped", createdAt: "not-a-date" }),
        run({
          id: "ok",
          status: "stopped",
          createdAt: "2026-01-10T00:00:00.000Z",
        }),
      ],
      from,
      to,
    );
    expect(filtered.map((r) => r.id)).toEqual(["ok"]);
  });
});
