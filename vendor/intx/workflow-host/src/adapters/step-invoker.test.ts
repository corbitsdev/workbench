import { describe, expect, test } from "bun:test";

import type { Mail } from "@intx/types/runtime";

import { buildInboundMessageFromMail } from "./step-invoker";

function mailWithSubject(subject: string | undefined): Mail {
  return {
    headers: {
      from: "sender@example.com",
      to: ["agent@local"],
      ...(subject !== undefined ? { subject } : {}),
    },
    rawHeaders: {},
    parts: [{ contentType: "text/plain", ref: "part_1", text: "hi" }],
  } as Mail;
}

describe("buildInboundMessageFromMail", () => {
  test("an empty Subject header is treated as absent", async () => {
    const message = await buildInboundMessageFromMail(
      mailWithSubject(""),
      undefined,
    );

    expect(message.headers.subject).toBeUndefined();
  });
});
