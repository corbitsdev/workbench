import { describe, expect, test } from "bun:test";
import { runOutcomeStatus, runStatusLabel } from "./run-outcome";

describe("runOutcomeStatus", () => {
  test("returns completed when a running run has a non-empty endedAt", () => {
    expect(runOutcomeStatus({ status: "running", endedAt: "2026-09-10T09:01:00.000Z" })).toBe(
      "completed",
    );
  });

  test("preserves running when endedAt is absent, null, or empty", () => {
    expect(runOutcomeStatus({ status: "running" })).toBe("running");
    expect(runOutcomeStatus({ status: "running", endedAt: null })).toBe("running");
    expect(runOutcomeStatus({ status: "running", endedAt: "" })).toBe("running");
  });

  test("preserves non-running statuses unchanged", () => {
    expect(runOutcomeStatus({ status: "completed", endedAt: "2026-09-10T09:01:00.000Z" })).toBe(
      "completed",
    );
    expect(runOutcomeStatus({ status: "failed", endedAt: "2026-09-10T09:01:00.000Z" })).toBe(
      "failed",
    );
    expect(runOutcomeStatus({ status: "error", endedAt: "2026-09-10T09:01:00.000Z" })).toBe(
      "error",
    );
    expect(runOutcomeStatus({ status: "stopped" })).toBe("stopped");
  });
});

describe("runStatusLabel", () => {
  test("maps known statuses to display labels and falls back to raw status", () => {
    expect(runStatusLabel("running")).toBe("Running now");
    expect(runStatusLabel("completed")).toBe("Finished");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("error")).toBe("Failed");
    expect(runStatusLabel("cancelled")).toBe("Cancelled");
    expect(runStatusLabel("stopped")).toBe("stopped");
  });
});
