import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { MailboxListResponse, MailboxMessage } from "./mailbox";

const goodMessage = {
  id: "pm-1",
  from: "ins_dep-heartbeat@tenant.example",
  to: ["usr_alice@tenant.example"],
  subject: "Morning brief",
  date: "2026-07-10T07:00:00.000Z",
  messageId: "<m1@tenant.example>",
  snippet: "Your brief is ready.",
  read: false,
};

describe("MailboxMessage", () => {
  test("accepts a full message", () => {
    expect(MailboxMessage(goodMessage)).toEqual(goodMessage);
  });

  test("accepts a message without the optional subject and snippet", () => {
    const { subject: _subject, snippet: _snippet, ...bare } = goodMessage;
    expect(MailboxMessage(bare)).toEqual(bare);
  });

  test("rejects a missing date", () => {
    const { date: _date, ...noDate } = goodMessage;
    expect(MailboxMessage(noDate) instanceof type.errors).toBe(true);
  });

  test("rejects a non-array to field", () => {
    const bad = { ...goodMessage, to: "usr_alice@tenant.example" };
    expect(MailboxMessage(bad) instanceof type.errors).toBe(true);
  });

  test("rejects a non-boolean read flag", () => {
    const bad = { ...goodMessage, read: "no" };
    expect(MailboxMessage(bad) instanceof type.errors).toBe(true);
  });
});

describe("MailboxListResponse", () => {
  test("accepts a populated list", () => {
    const payload = { messages: [goodMessage] };
    expect(MailboxListResponse(payload)).toEqual(payload);
  });

  test("round-trips an empty list", () => {
    expect(MailboxListResponse({ messages: [] })).toEqual({ messages: [] });
  });

  test("rejects a list with a malformed message", () => {
    const payload = { messages: [{ id: "pm-1" }] };
    expect(MailboxListResponse(payload) instanceof type.errors).toBe(true);
  });
});
