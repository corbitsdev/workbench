import { describe, expect, test } from "bun:test";

import {
  buildAttioTaskAgentBlocks,
  SYNC_APPROVAL_SIGNAL,
  type AttioTaskAgentBlockInput,
} from "./blocks";

// A run parked on the DESTRUCTIVE sync-approval gate whose upstream task/record
// outputs decode as malformed — the case the dock used to dead-end on.
function malformedSyncApprovalInput(): AttioTaskAgentBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      { stepId: "fetchTask", phase: "completed" },
      { stepId: "selectTask", phase: "completed" },
      {
        stepId: "syncApproval",
        phase: "awaiting-signal",
        awaitingSignalName: SYNC_APPROVAL_SIGNAL,
      },
    ],
    stepOutputs: {
      // Present (not pending) but the wrong shape → parseFirstLinkedRecord returns
      // "malformed".
      fetchTask: { linkedRecords: 123 },
      selectTask: { taskId: 456 },
    },
  };
}

describe("attio sync-approval malformed decode (CL-2684)", () => {
  test("appends a run-page link so the user isn't stranded on the destructive gate", () => {
    const blocks = buildAttioTaskAgentBlocks(malformedSyncApprovalInput());

    const error = blocks.find((b) => b.kind === "error");
    expect(error).toBeDefined();

    // The dead-end is escaped: a run-page link accompanies the error so the
    // write-back can still be completed.
    const link = blocks.find((b) => b.kind === "link");
    if (link === undefined || link.kind !== "link") {
      throw new Error("expected a run-page link on the malformed sync gate");
    }
    expect(link.url).toBe("/workflows/run_1");

    // The gate never offers a destructive confirm/skip choice when the decode is
    // malformed — only the error + the escape link.
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
  });
});
