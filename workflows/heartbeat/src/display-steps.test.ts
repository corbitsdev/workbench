import { describe, expect, test } from "bun:test";
import { workflow } from "./index";
import {
  DISPLAY_STEPS,
  HEARTBEAT_FAILURE_WATCH_STEP_IDS,
} from "./display-steps";

describe("heartbeat DISPLAY_STEPS", () => {
  test("every runtime step is in the stepper groups or failure watch list", () => {
    const stepperIds = new Set(DISPLAY_STEPS.flatMap((g) => g.stepIds));
    const watchIds = new Set(HEARTBEAT_FAILURE_WATCH_STEP_IDS);
    for (const id of workflow.stepOrder) {
      expect(stepperIds.has(id) || watchIds.has(id)).toBe(true);
    }
  });

  test("failure watch covers plumbing steps omitted from the stepper", () => {
    expect(HEARTBEAT_FAILURE_WATCH_STEP_IDS).toContain("merge-sources");
    expect(HEARTBEAT_FAILURE_WATCH_STEP_IDS).toContain("title");
    expect(HEARTBEAT_FAILURE_WATCH_STEP_IDS).toContain("document");
    expect(HEARTBEAT_FAILURE_WATCH_STEP_IDS).toContain("notify-prep");
  });
});
