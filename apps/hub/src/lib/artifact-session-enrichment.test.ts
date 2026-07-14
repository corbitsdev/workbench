import { describe, expect, it } from "bun:test";
import {
  sessionProvenanceKey,
  workflowRunStatusToSessionStatus,
} from "./artifact-session-enrichment";

describe("artifact-session-enrichment", () => {
  it("reads sessionId from provenance source", () => {
    expect(
      sessionProvenanceKey({
        origin: "workflow",
        sessionId: "ses_abc",
      }),
    ).toBe("ses_abc");
    expect(sessionProvenanceKey({ origin: "manual" })).toBeNull();
  });

  it("maps workflow run status to SessionStatus", () => {
    expect(workflowRunStatusToSessionStatus("provisioning")).toBe("pending");
    expect(workflowRunStatusToSessionStatus("running")).toBe("generating");
    expect(workflowRunStatusToSessionStatus("awaiting")).toBe("reviewing");
    expect(workflowRunStatusToSessionStatus("completed")).toBe("done");
    expect(workflowRunStatusToSessionStatus("failed")).toBe("failed");
  });
});