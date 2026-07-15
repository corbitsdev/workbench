import { describe, expect, it } from "bun:test";
import {
  composeTriagePromptMessage,
  isBounceSenderAddress,
  isSystemSenderAddress,
  isTriageHandoffSubject,
  triageHandoffSubject,
  triageMessageKey,
  TRIAGE_TEMPLATE_KEY,
} from "./mailbox-triage-policy";

describe("isSystemSenderAddress", () => {
  it("flags hub and myra local-parts as system senders", () => {
    expect(isSystemSenderAddress("hub@tenant.example")).toBe(true);
    expect(isSystemSenderAddress("myra@tenant.example")).toBe(true);
  });

  it("does not flag an ordinary sender", () => {
    expect(isSystemSenderAddress("partner@outside.example")).toBe(false);
  });
});

describe("isBounceSenderAddress", () => {
  it.each([
    "mailer-daemon",
    "postmaster",
    "no-reply",
    "noreply",
    "do-not-reply",
    "donotreply",
    "bounce",
    "bounces",
    "MAILER-DAEMON",
    "bounces+abc123",
    "No-Reply+campaign42",
  ])("flags bounce/postmaster sender %s", (localPart) => {
    expect(isBounceSenderAddress(`${localPart}@outside.example`)).toBe(true);
  });

  it("does not misclassify a bounce sender when the local part itself contains an @ (splitMailAddress lastIndexOf semantics)", () => {
    // splitMailAddress anchors on the LAST `@`, so the local part here is
    // "bounce@import", which is NOT in the bounce set.
    expect(isBounceSenderAddress("bounce@import@outside.example")).toBe(false);
  });

  it("does not flag an ordinary sender", () => {
    expect(isBounceSenderAddress("partner@outside.example")).toBe(false);
  });
});

describe("isTriageHandoffSubject", () => {
  it("flags a subject carrying the triage handoff prefix", () => {
    expect(isTriageHandoffSubject("Myra triaged: Partnership intro")).toBe(
      true,
    );
  });

  it("does not flag an ordinary subject", () => {
    expect(isTriageHandoffSubject("Partnership intro")).toBe(false);
  });

  it("treats an undefined subject as not a handoff", () => {
    expect(isTriageHandoffSubject(undefined)).toBe(false);
  });
});

describe("triageHandoffSubject / triageMessageKey", () => {
  it("prefixes the original subject with the triage handoff marker", () => {
    expect(triageHandoffSubject("Partnership intro")).toBe(
      "Myra triaged: Partnership intro",
    );
  });

  it("derives the dedupe key from the mailbox row id", () => {
    expect(triageMessageKey("row-1")).toBe("triage:row-1");
  });
});

describe("composeTriagePromptMessage", () => {
  it("frames the inbound message as a triage instruction with the envelope and body", () => {
    const content = composeTriagePromptMessage({
      subject: "Partnership intro",
      from: "partner@outside.example",
      to: "usr_alice@tenant.example",
      rowId: "row-1",
      date: "Fri, 10 Jul 2026 07:00:00 +0000",
      body: "Hi Alice, keen to explore a partnership.",
    });
    expect(content).toContain("Triage this inbound message.");
    expect(content).toContain("From: partner@outside.example");
    expect(content).toContain("To: usr_alice@tenant.example");
    expect(content).toContain("Subject: Partnership intro");
    expect(content).toContain("Mailbox message id: row-1");
    expect(content).toContain("Date: Fri, 10 Jul 2026 07:00:00 +0000");
    expect(content).toContain("keen to explore a partnership");
  });

  it("omits the Date line when no date is available", () => {
    const content = composeTriagePromptMessage({
      subject: "Partnership intro",
      from: "partner@outside.example",
      to: "usr_alice@tenant.example",
      rowId: "row-1",
      body: "Hi Alice.",
    });
    expect(content).not.toContain("Date:");
  });
});

describe("TRIAGE_TEMPLATE_KEY", () => {
  it("is the stable member_agent_instance.templateKey for a triage instance", () => {
    expect(TRIAGE_TEMPLATE_KEY).toBe("myra-triage");
  });
});
