import { describe, expect, test } from "bun:test";

import { CHAT_STRINGS } from "./strings";
import { displayWorkbenchTitle } from "./workbench-display-title";

describe("displayWorkbenchTitle", () => {
  test("a title equal to the workbench's own id reads as New workbench", () => {
    const id = "run_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    expect(displayWorkbenchTitle(id, id)).toBe(CHAT_STRINGS.newWorkbenchTitle);
  });

  test("a title matching the run-id shape reads as New workbench even for a different id", () => {
    const runId = "run_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    expect(displayWorkbenchTitle(runId, "some-other-id")).toBe(
      CHAT_STRINGS.newWorkbenchTitle,
    );
  });

  test("a legacy instance-id-shaped title reads as New workbench", () => {
    const insId = "ins_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    expect(displayWorkbenchTitle(insId, "some-other-id")).toBe(
      CHAT_STRINGS.newWorkbenchTitle,
    );
  });

  test("a real title renders unchanged", () => {
    expect(displayWorkbenchTitle("Myra", "run_abc")).toBe("Myra");
  });

  test("an empty title passes through unchanged for callers to apply their own fallback", () => {
    expect(displayWorkbenchTitle("", "run_abc")).toBe("");
  });
});
