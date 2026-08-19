import { describe, expect, test } from "bun:test";

import {
  extractConversationText,
  hasConversationText,
} from "./conversation-text";

const CRLF = "\r\n";

// The exact shape @corbits/chat's `encodeParts` produces for an event-only
// send: a signed envelope whose mixed body carries an EMPTY text/plain part
// plus the event's JSON attachment.
function eventOnlyMail(): Uint8Array {
  const inner = "----=_Part_inner";
  const outer = "----=_Part_outer";
  const raw = [
    "From: prn_1@alice.localhost",
    "To: run_1@alice.localhost",
    "MIME-Version: 1.0",
    `Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="${outer}"`,
    "Interchange-Type: conversation.message",
    "",
    `--${outer}`,
    `Content-Type: multipart/mixed; boundary="${inner}"`,
    "",
    `--${inner}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "",
    `--${inner}`,
    "Content-Type: application/json",
    "Content-Transfer-Encoding: 7bit",
    'Content-Disposition: attachment; filename="part-0.json"',
    "",
    '{"kind":"event","event":"workbench.agent-joined","data":{"address":"run_2@alice.localhost"}}',
    `--${inner}--`,
    "",
    `--${outer}--`,
    "",
  ].join(CRLF);
  return new TextEncoder().encode(raw);
}

describe("hasConversationText", () => {
  test("accepts a real turn", () => {
    expect(hasConversationText("what's the status?")).toBe(true);
  });

  test("rejects an empty body", () => {
    expect(hasConversationText("")).toBe(false);
  });

  test("rejects a whitespace-only body", () => {
    expect(hasConversationText("\r\n  \t\n")).toBe(false);
  });

  test("rejects what an event-only send extracts to", () => {
    // The regression: this mail resumed a parked run with "" and killed it.
    const text = extractConversationText(eventOnlyMail(), "<m@alice.localhost>");
    expect(hasConversationText(text)).toBe(false);
  });
});
