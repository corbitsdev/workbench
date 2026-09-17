import { describe, expect, test } from "bun:test";
import { FIRE_RUNNING_WINDOW_MS } from "@corbits/workflows/client";

import { elapsedLabel, isRunningNow } from "./insights-page";
import type { InsightsRun } from "../insights-api";

function run(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "createdAt">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "wfd_a",
    definitionName: "Research brief",
    address: "addr",
    status: "running",
    updatedAt: partial.createdAt,
    routineId: null,
    routineName: null,
    ...partial,
  };
}

describe("elapsedLabel", () => {
  test("formats wall-clock time since createdAt", () => {
    const now = Date.parse("2026-01-01T00:02:12.000Z");
    expect(elapsedLabel("2026-01-01T00:00:00.000Z", now)).toBe("2.2m");
  });

  test("an invalid timestamp reads as unknown, not a fabricated duration", () => {
    expect(elapsedLabel("not-a-date", Date.now())).toBe("—");
  });
});

describe("isRunningNow", () => {
  test("a running run still inside the fire window is in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "fresh",
          createdAt: new Date().toISOString(),
          status: "running",
        }),
      ),
    ).toBe(true);
  });

  test("updating is in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "updating",
          createdAt: new Date().toISOString(),
          status: "updating",
        }),
      ),
    ).toBe(true);
  });

  test("a stopped run is not in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "done",
          createdAt: new Date().toISOString(),
          status: "stopped",
        }),
      ),
    ).toBe(false);
  });

  // Warm-keep (CL-6681 / CL-6778): a routine's delivery agent stays deployed
  // after it replies, so workflow_run.status lingers on `running`. Past the
  // fire window that is not an in-flight job — Insights must not keep it in
  // "Running now" forever.
  test("endedAt drops in-flight immediately, even while status is still running inside the window", () => {
    expect(
      isRunningNow(
        run({
          id: "just-finished",
          createdAt: new Date().toISOString(),
          status: "running",
          endedAt: new Date().toISOString(),
        }),
      ),
    ).toBe(false);
  });

  test("a live running run past the fire window is still in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "stale",
          createdAt: new Date(
            Date.now() - FIRE_RUNNING_WINDOW_MS - 1,
          ).toISOString(),
          status: "running",
        }),
      ),
    ).toBe(true);
  });
});
