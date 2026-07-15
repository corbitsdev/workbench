import { describe, expect, it } from "bun:test";
import { composeGateMailBody, composeGateMailSubject } from "./gate-mail-copy";

describe("composeGateMailSubject", () => {
  it("names the workflow in the subject line", () => {
    expect(composeGateMailSubject("Content Pipeline")).toBe(
      "A workflow needs you: Content Pipeline",
    );
  });
});

describe("composeGateMailBody", () => {
  it("includes the run, workflow, gate, and deep link", () => {
    const body = composeGateMailBody({
      label: "Content Pipeline",
      runId: "wfr-1",
      signalName: "approve_draft",
      choices: undefined,
      deepLinkPath: "/insights/trace/wfr-1",
    });
    expect(body).toContain('The "Content Pipeline" workflow run is waiting');
    expect(body).toContain("Run: wfr-1");
    expect(body).toContain("Gate: approve_draft");
    expect(body).toContain("Respond here: /insights/trace/wfr-1");
    expect(body).not.toContain("Expected response:");
  });

  it("surfaces expected-response choices when the gate declares them", () => {
    const body = composeGateMailBody({
      label: "Content Pipeline",
      runId: "wfr-1",
      signalName: "approve_draft",
      choices: "approve | reject",
      deepLinkPath: "/insights/trace/wfr-1",
    });
    expect(body).toContain("Expected response: approve | reject");
  });
});
