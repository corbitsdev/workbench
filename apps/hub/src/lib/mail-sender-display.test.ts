import { describe, expect, it } from "bun:test";
import {
  attachFromDisplay,
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

  it("returns fromDisplay only when a distinct label exists", () => {
    const map = new Map([["ins_dep@tenant.example", "Heartbeat"]]);
    expect(
      attachFromDisplay("ins_dep@tenant.example", map),
    ).toBe("Heartbeat");
    expect(attachFromDisplay("unknown@tenant.example", map)).toBeUndefined();
  });
});