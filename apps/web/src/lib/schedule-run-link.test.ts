import { describe, expect, it } from "bun:test";
import { deepLinkPath } from "@workbench/shared";
import { scheduleRunDeepLink } from "./schedule-run-link";

describe("scheduleRunDeepLink", () => {
  it("routes awaiting runs to the workflow surface", () => {
    expect(scheduleRunDeepLink("awaiting", "run-1")).toBe(
      deepLinkPath("workflow_run", "run-1"),
    );
  });

  it("routes terminal runs to the insights trace surface", () => {
    expect(scheduleRunDeepLink("completed", "run-1")).toBe(
      deepLinkPath("workflow_trace", "run-1"),
    );
  });
});
