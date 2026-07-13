import { describe, expect, it } from "bun:test";
import {
  attachFromDisplay,
  deploymentIdFromInsMailboxAddress,
  extractSenderMailboxAddress,
} from "./mail-sender-display";

describe("mail-sender-display", () => {
  it("extracts the mailbox address from an angle-addr From header", () => {
    expect(
      extractSenderMailboxAddress(
        "ins_ses_64a01d3a004907cb97e6efd1f22ec341@abklabs.com",
      ),
    ).toBe("ins_ses_64a01d3a004907cb97e6efd1f22ec341@abklabs.com");
    expect(
      extractSenderMailboxAddress(
        '"Heartbeat" <ins_dep-heartbeat@tenant.example>',
      ),
    ).toBe("ins_dep-heartbeat@tenant.example");
  });

  it("parses deployment id from ephemeral workflow instance addresses", () => {
    expect(
      deploymentIdFromInsMailboxAddress(
        "ins_ses_64a01d3a004907cb97e6efd1f22ec341@abklabs.com",
      ),
    ).toBe("ses_64a01d3a004907cb97e6efd1f22ec341");
    expect(
      deploymentIdFromInsMailboxAddress(
        "ins_ses_abc-send-brief@tenant.example",
      ),
    ).toBe("ses_abc");
  });

  it("returns fromDisplay only when a distinct label exists", () => {
    const map = new Map([["ins_dep@tenant.example", "Heartbeat"]]);
    expect(
      attachFromDisplay("ins_dep@tenant.example", map),
    ).toBe("Heartbeat");
    expect(attachFromDisplay("unknown@tenant.example", map)).toBeUndefined();
  });
});