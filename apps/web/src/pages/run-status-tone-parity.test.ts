// Guards against the exact bug this file was added for (design
// review): a page grows its own run-status → tone map/function instead of
// reading react-ui's `RUN_STATUS_TONE` (`workflow-run.ts`), and it quietly
// disagrees — a cancelled run reading neutral grey on Routines and amber
// warning on Insights, the same status meaning two different things in one
// product. `RUN_STATUS_TONE` is the one place a run-status tone is allowed
// to be decided; every surface below must normalize its own status
// vocabulary onto react-ui's `RunStatus` and read the tone from there.
//
// A static scan can't verify this: the divergence this catches was a
// `case "stopped": return "warning"` inside a switch, not an object
// literal, and re-deriving "is this tone value equal to canonical" from
// source text would mean parsing arbitrary JS — the general-purpose lint
// framework this ticket explicitly says not to build. Calling the real
// exported code and comparing its output to `RUN_STATUS_TONE` catches both
// shapes (switch or map) with no parser.
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
