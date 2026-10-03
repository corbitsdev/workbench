import { describe, expect, test } from "bun:test";

import { expiryIsoFromPreset, expiryLabelFromPreset, grantPreviewSentence } from "./grant-preview";

describe("grantPreviewSentence", () => {
  test("an allow reads as permission for the named target", () => {
    expect(
      grantPreviewSentence({
        targetLabel: "Billing",
        resource: "credential",
        action: "use",
        effect: "allow",
        expiresLabel: null,
      }),
    ).toBe("Billing may use on credential.");
  });

  test("a deny reads as refusal, and an ask as a checkpoint", () => {
    expect(
      grantPreviewSentence({
        targetLabel: "Deploy bot",
        resource: "workflow-run",
        action: "create",
        effect: "deny",
        expiresLabel: null,
      }),
    ).toBe("Deploy bot must not create on workflow-run.");
    expect(
      grantPreviewSentence({
        targetLabel: "Deploy bot",
        resource: "workflow-run",
        action: "create",
        effect: "ask",
        expiresLabel: null,
      }),
    ).toBe("Deploy bot must ask before they can create on workflow-run.");
  });

  test("a missing target falls back to Someone, and an expiry extends the sentence", () => {
    expect(
      grantPreviewSentence({
        targetLabel: null,
        resource: "credential",
        action: "use",
        effect: "allow",
        expiresLabel: null,
      }),
    ).toBe("Someone may use on credential.");
    expect(
      grantPreviewSentence({
        targetLabel: "   ",
        resource: "credential",
        action: "use",
        effect: "allow",
        expiresLabel: "in 7 days",
      }),
    ).toBe("Someone may use on credential, until in 7 days.");
  });
});

describe("expiry presets", () => {
  test("never means no expiry in both projections", () => {
    expect(expiryIsoFromPreset("never")).toBeNull();
    expect(expiryLabelFromPreset("never")).toBeNull();
  });

  test("a 7d preset lands exactly seven days after now", () => {
    const now = new Date("2026-02-10T00:00:00.000Z");
    expect(expiryIsoFromPreset("7d", now)).toBe("2026-02-17T00:00:00.000Z");
    expect(expiryLabelFromPreset("7d")).toBe("in 7 days");
  });
});
