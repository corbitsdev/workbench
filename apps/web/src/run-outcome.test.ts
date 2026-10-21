import { describe, expect, test } from "bun:test";

import { routineState, runOutcomeStatus } from "./run-outcome";
import { runFailureMessage } from "./insights-api";

describe("runOutcomeStatus", () => {
  test("a running run with endedAt set settles as completed", () => {
    expect(runOutcomeStatus({ status: "running", endedAt: "2026-10-13T12:01:00Z" })).toBe(
      "completed",
    );
  });

  test("a running run without endedAt stays running", () => {
    expect(runOutcomeStatus({ status: "running" })).toBe("running");
    expect(runOutcomeStatus({ status: "running", endedAt: null })).toBe("running");
    expect(runOutcomeStatus({ status: "running", endedAt: "" })).toBe("running");
  });

  test("an errored run normalizes to failed", () => {
    expect(runOutcomeStatus({ status: "error" })).toBe("failed");
  });
});

describe("routineState", () => {
  const deployed = { definition: { status: "deployed" as const, scheduleEnabled: true } };

  test("the newest run's failure outranks the deployment's own state", () => {
    expect(
      routineState(
        { definition: { status: "stopped", scheduleEnabled: false } },
        { status: "error" },
      ),
    ).toEqual({ tone: "failed", label: "failed" });
  });

  test("a stopped definition or paused schedule reads paused", () => {
    expect(
      routineState(
        { definition: { status: "stopped", scheduleEnabled: true } },
        { status: "deployed" },
      ),
    ).toEqual({ tone: "idle", label: "paused" });
    expect(
      routineState(
        { definition: { status: "deployed", scheduleEnabled: false } },
        { status: "running" },
      ),
    ).toEqual({ tone: "idle", label: "paused" });
  });

  test("an active last run reads running, otherwise live", () => {
    expect(routineState(deployed, { status: "running" })).toEqual({
      tone: "info",
      label: "running",
    });
    expect(routineState(deployed, { status: "updating" })).toEqual({
      tone: "info",
      label: "running",
    });
    expect(routineState(deployed, { status: "deployed" })).toEqual({
      tone: "live",
      label: "live",
    });
    expect(routineState(deployed, undefined)).toEqual({ tone: "live", label: "live" });
  });
});

describe("runFailureMessage", () => {
  test("extracts nested error.message from RunFailed or StepFailed events", () => {
    expect(
      runFailureMessage([
        { seq: 1, type: "RunStarted", body: {} },
        { seq: 2, type: "StepFailed", body: { error: { message: "boom" } } },
      ]),
    ).toBe("boom");
  });

  test("extracts top-level message or string error from failure events, newest first", () => {
    expect(
      runFailureMessage([
        { seq: 1, type: "StepError", body: { message: "older" } },
        { seq: 2, type: "RunFailed", body: { error: "direct string error" } },
      ]),
    ).toBe("direct string error");
  });

  test("returns null when no failure event carries a message", () => {
    expect(runFailureMessage([{ seq: 1, type: "RunStarted", body: {} }])).toBeNull();
  });
});
