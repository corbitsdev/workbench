// Guards against a page growing its own run-status -> tone map that
// quietly disagrees with react-ui's `RUN_STATUS_TONE` — e.g. a cancelled
// run reading grey on Routines and amber on Insights. Calls the real
// exported code and compares output, since a static scan can't tell a
// switch's tone from an object literal's without parsing arbitrary JS.
import { describe, expect, test } from "bun:test";

import { RUN_STATUS_TONE } from "@corbits/react-ui";

import { statusTone } from "./insights-page";

describe("run-status tone parity with react-ui's RUN_STATUS_TONE", () => {
  test("Insights' statusTone agrees with canonical for every shared status", () => {
    // WorkflowRunStatus ("running"/"stopped") spells these two the same way
    // RunStatus does — the exact pair the reviewer caught disagreeing.
    expect(statusTone("running")).toBe(RUN_STATUS_TONE.running);
    expect(statusTone("stopped")).toBe(RUN_STATUS_TONE.stopped);
  });
});
