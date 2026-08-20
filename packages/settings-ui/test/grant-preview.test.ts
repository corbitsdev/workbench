import { describe, expect, test } from "bun:test";

import {
  expiryIsoFromPreset,
  expiryLabelFromPreset,
  grantPreviewSentence,
} from "../src/grant-preview";

describe("grantPreviewSentence", () => {
  test("defaults the subject when no target is chosen", () => {
    expect(
      grantPreviewSentence({
        targetLabel: null,
        resource: "workbench",
        action: "write",
        effect: "ask",
        expiresLabel: null,
      }),
    ).toBe("Someone must ask before they can write on workbench.");
  });

  test("uses allow / deny verbs", () => {
    expect(
      grantPreviewSentence({
        targetLabel: "Billing",
        resource: "credential",
        action: "read",
        effect: "allow",
        expiresLabel: null,
      }),
    ).toBe("Billing may read on credential.");
    expect(
      grantPreviewSentence({
        targetLabel: "Billing",
        resource: "credential",
        action: "read",
        effect: "deny",
        expiresLabel: "in 7 days",
      }),
    ).toBe("Billing must not read on credential, until in 7 days.");
  });
});

describe("expiry presets", () => {
  test("never has no iso and no label", () => {
    expect(expiryIsoFromPreset("never")).toBeNull();
    expect(expiryLabelFromPreset("never")).toBeNull();
  });

  test("24h is one day ahead of now", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    expect(expiryIsoFromPreset("24h", now)).toBe("2026-08-11T12:00:00.000Z");
    expect(expiryLabelFromPreset("24h")).toBe("in 24 hours");
  });
});
