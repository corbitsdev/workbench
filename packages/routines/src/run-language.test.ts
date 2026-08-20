import { describe, expect, test } from "bun:test";

import {
  fireNeverStarted,
  runStatusLabel,
  triggeredByLabel,
} from "./run-language";

describe("runStatusLabel", () => {
  test("every status a routine surface can show reads as words", () => {
    expect(runStatusLabel("running")).toBe("Running now");
    expect(runStatusLabel("completed")).toBe("Finished");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("cancelled")).toBe("Cancelled");
    expect(runStatusLabel("queued")).toBe("Waiting to start");
  });

  test("an unrecognised status is shown, not swallowed", () => {
    expect(runStatusLabel("reticulating")).toBe("reticulating");
  });
});

describe("triggeredByLabel", () => {
  test("the cause of a fire reads as words, not a column value", () => {
    expect(triggeredByLabel("schedule")).toBe("On schedule");
    expect(triggeredByLabel("manual")).toBe("By hand");
    expect(triggeredByLabel("run-now")).toBe("By hand");
    expect(triggeredByLabel("once")).toBe("On creation");
    expect(triggeredByLabel("webhook")).toBe("By webhook");
  });

  test("both synthetic launch-failure rows read the same way", () => {
    expect(triggeredByLabel("schedule-failed")).toBe("Failed to start");
    expect(triggeredByLabel("once-failed")).toBe("Failed to start");
  });
});

describe("fireNeverStarted", () => {
  test("true only for the fires that produced no platform run", () => {
    expect(fireNeverStarted("schedule-failed")).toBe(true);
    expect(fireNeverStarted("once-failed")).toBe(true);
    expect(fireNeverStarted("schedule")).toBe(false);
    expect(fireNeverStarted("manual")).toBe(false);
  });
});
