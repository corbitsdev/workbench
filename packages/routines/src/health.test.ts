import { describe, expect, test } from "bun:test";

import {
  cleanFireStreak,
  lastFailedFire,
  medianFireDurationMs,
  routineHealth,
} from "./health";
import type { RoutineFire, RoutineHealthSubject } from "./health";

const healthy: RoutineHealthSubject = {
  enabled: true,
  consecutiveFailures: 0,
  deadLetteredAt: null,
};

function fire(
  runId: string,
  overrides: Partial<RoutineFire> = {},
  run: Record<string, unknown> = { status: "completed" },
): RoutineFire {
  return {
    runId,
    triggeredBy: "schedule",
    createdAt: "2026-01-01T00:00:00.000Z",
    run,
    ...overrides,
  };
}

describe("cleanFireStreak", () => {
  test("counts successes from the newest fire and stops at the first failure", () => {
    expect(
      cleanFireStreak([
        fire("r5"),
        fire("r4"),
        fire("r3", {}, { status: "failed" }),
        fire("r2"),
      ]),
    ).toBe(2);
  });

  test("an in-flight run neither breaks nor extends the streak", () => {
    expect(
      cleanFireStreak([fire("r2", {}, { status: "running" }), fire("r1")]),
    ).toBe(1);
  });

  test("no history is a streak of zero, not a failure", () => {
    expect(cleanFireStreak([])).toBe(0);
  });
});

describe("lastFailedFire", () => {
  test("a synthetic launch failure counts as a failure and carries its message", () => {
    expect(
      lastFailedFire([
        fire("r2"),
        fire(
          "r1",
          {
            triggeredBy: "schedule-failed",
            error: "sidecar unreachable",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {},
        ),
      ]),
    ).toEqual({ at: "2026-01-02T00:00:00.000Z", error: "sidecar unreachable" });
  });

  test("null when nothing in the history failed", () => {
    expect(lastFailedFire([fire("r1")])).toBeNull();
  });
});

describe("medianFireDurationMs", () => {
  function timed(runId: string, seconds: number): RoutineFire {
    return fire(
      runId,
      {},
      {
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000,
        ).toISOString(),
      },
    );
  }

  test("the middle duration of an odd number of finished fires", () => {
    expect(
      medianFireDurationMs([timed("a", 10), timed("b", 2), timed("c", 6)]),
    ).toBe(6_000);
  });

  test("averages the middle pair for an even count", () => {
    expect(medianFireDurationMs([timed("a", 2), timed("b", 6)])).toBe(4_000);
  });

  test("one outlier cannot move the median", () => {
    expect(
      medianFireDurationMs([timed("a", 12), timed("b", 12), timed("c", 3600)]),
    ).toBe(12_000);
  });

  test("null when no fire recorded both ends", () => {
    expect(medianFireDurationMs([fire("a")])).toBeNull();
    expect(medianFireDurationMs([])).toBeNull();
  });
});

describe("routineHealth", () => {
  test("a disabled routine is Off whatever its history says", () => {
    const health = routineHealth({ ...healthy, enabled: false }, [
      fire("r1", {}, { status: "failed" }),
    ]);
    expect(health.state).toBe("off");
    expect(health.label).toBe("Off");
  });

  test("a dead-lettered routine is Paused, not merely failing", () => {
    const health = routineHealth(
      {
        enabled: true,
        consecutiveFailures: 3,
        deadLetteredAt: "2026-01-03T00:00:00.000Z",
      },
      [],
    );
    expect(health.state).toBe("paused");
    expect(health.caption).toContain("resumes");
  });

  test("an in-flight latest run reports Running now", () => {
    expect(
      routineHealth(healthy, [fire("r1", {}, { status: "running" })]).state,
    ).toBe("running");
  });

  test("consecutive failures are stated in the caption, not just the pill", () => {
    const health = routineHealth({ ...healthy, consecutiveFailures: 2 }, [
      fire("r1", { error: "boom" }, {}),
    ]);
    expect(health.state).toBe("failing");
    expect(health.caption).toContain("2 runs failed in a row");
  });

  test("never run yet is idle, not healthy and not failing", () => {
    expect(routineHealth(healthy, []).state).toBe("idle");
  });

  test("a clean streak reads as healthy and reports the streak", () => {
    const health = routineHealth(healthy, [fire("r2"), fire("r1")]);
    expect(health.state).toBe("ok");
    expect(health.cleanStreak).toBe(2);
    expect(health.caption).toContain("2 runs in a row");
  });

  test("last run is the newest history row, whatever started it — never the scheduler's own stamp", () => {
    // A run-now-only routine never gets a `lastFireAt` (the store writes
    // that inside the scheduled-claim path), so reading anything else
    // here would report "never run" beside a full history table.
    const manual = fire("r1", {
      triggeredBy: "manual",
      createdAt: "2026-02-01T10:00:00.000Z",
    });
    expect(routineHealth(healthy, [manual]).lastRunAt).toBe(
      "2026-02-01T10:00:00.000Z",
    );
  });

  test("no history means no last run", () => {
    expect(routineHealth(healthy, []).lastRunAt).toBeNull();
  });

  test("carries the last failure through even while healthy again", () => {
    const health = routineHealth(healthy, [
      fire("r2"),
      fire(
        "r1",
        { error: "timed out", createdAt: "2026-01-01T05:00:00.000Z" },
        {},
      ),
    ]);
    expect(health.state).toBe("ok");
    expect(health.lastFailure).toEqual({
      at: "2026-01-01T05:00:00.000Z",
      error: "timed out",
    });
  });
});
