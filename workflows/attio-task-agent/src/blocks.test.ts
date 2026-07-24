import { describe, expect, test } from "bun:test";

import {
  buildAttioTaskAgentBlocks,
  MEMBER_SELECTION_SIGNAL,
  SYNC_APPROVAL_SIGNAL,
  type AttioTaskAgentBlockInput,
} from "./blocks";

function toolEnvelope(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

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

function memberSelectionInput(
  overrides: Partial<AttioTaskAgentBlockInput> = {},
): AttioTaskAgentBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      {
        stepId: MEMBER_SELECTION_SIGNAL,
        phase: "awaiting-signal",
        awaitingSignalName: MEMBER_SELECTION_SIGNAL,
      },
    ],
    stepOutputs: {},
    ...overrides,
  };
}

describe("attio member-selection gate fallback (CL-4284)", () => {
  test("an error naming listMembers when it FAILED, with a CLASSIFIED detail, never a run-page link", () => {
    const blocks = buildAttioTaskAgentBlocks(
      memberSelectionInput({
        steps: [
          {
            stepId: "listMembers",
            phase: "failed",
            lastError: { message: "Attio API error: 403 Forbidden" },
          },
          {
            stepId: MEMBER_SELECTION_SIGNAL,
            phase: "awaiting-signal",
            awaitingSignalName: MEMBER_SELECTION_SIGNAL,
          },
        ],
      }),
    );
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
    const error = blocks.find((b) => b.kind === "error");
    if (error?.kind !== "error") throw new Error("expected an error block");
    expect(error.message).toContain("listMembers");
    expect(error.detail).toBe(
      "Attio declined the request (403). Check the connected Attio credential's access and try again.",
    );
    expect(error.detail).not.toContain("API error: 403");
  });

  test("an honest empty state when listMembers succeeded with zero members", () => {
    const blocks = buildAttioTaskAgentBlocks(
      memberSelectionInput({
        steps: [
          { stepId: "listMembers", phase: "completed" },
          {
            stepId: MEMBER_SELECTION_SIGNAL,
            phase: "awaiting-signal",
            awaitingSignalName: MEMBER_SELECTION_SIGNAL,
          },
        ],
        stepOutputs: { listMembers: toolEnvelope([]) },
      }),
    );
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
    const text = blocks.find((b) => b.kind === "text");
    expect(text?.kind === "text" && text.text).toBe(
      "No workspace members are available to assign.",
    );
  });

  test("no run-page link when already on the run page", () => {
    const blocks = buildAttioTaskAgentBlocks(
      memberSelectionInput({ surface: "run-page" }),
    );
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
  });
});

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
