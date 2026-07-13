import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  MailboxListResponse,
  MailboxMessage,
  MailboxMessageDetail,
  MailboxRefSchema,
  mailboxRefHref,
  isExternalMailboxRef,
  defaultRefLabel,
  mailboxSenderLabel,
} from "./mailbox";

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

  test("accepts optional fromDisplay", () => {
    const withDisplay = { ...goodMessage, fromDisplay: "Heartbeat" };
    expect(MailboxMessage(withDisplay)).toEqual(withDisplay);
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

describe("MailboxMessageDetail", () => {
  test("accepts a message with a full body", () => {
    const detail = { ...goodMessage, body: "Your brief is ready.\n\n- one" };
    expect(MailboxMessageDetail(detail)).toEqual(detail);
  });

  test("accepts an empty body (unparseable frame degrades, never 500s)", () => {
    const detail = { ...goodMessage, body: "" };
    expect(MailboxMessageDetail(detail)).toEqual(detail);
  });

  test("rejects a missing body", () => {
    expect(MailboxMessageDetail(goodMessage) instanceof type.errors).toBe(true);
  });
});

describe("MailboxRefSchema", () => {
  test("accepts each supported kind (internal deepLink kinds plus externals)", () => {
    for (const kind of [
      "artifact",
      "workflow_run",
      "task",
      "mail",
      "conversation",
      "linear",
      "url",
    ] as const) {
      const ref = { kind, ref: "x", label: "L" };
      expect(MailboxRefSchema(ref)).toEqual(ref);
    }
  });

  test("rejects an unknown kind", () => {
    const bad = { kind: "not-a-kind", ref: "x" };
    expect(MailboxRefSchema(bad) instanceof type.errors).toBe(true);
  });

  test("MailboxMessage carries an optional refs array", () => {
    const withRefs = {
      ...goodMessage,
      refs: [
        { kind: "workflow_run" as const, ref: "wfr-1", label: "Open run" },
      ],
    };
    expect(MailboxMessage(withRefs)).toEqual(withRefs);
  });
});

describe("mailboxRefHref", () => {
  test("internal kinds resolve through the deepLink helper", () => {
    expect(mailboxRefHref({ kind: "workflow_run", ref: "wfr-1" })).toBe(
      "/workflows/wfr-1",
    );
    expect(mailboxRefHref({ kind: "mail", ref: "pm-1" })).toBe("/inbox/pm-1");
    expect(
      mailboxRefHref({ kind: "artifact", ref: "art-1" }, "https://app.example"),
    ).toBe("https://app.example/artifacts/art-1");
  });

  test("external kinds return their raw URL and report as external", () => {
    const linear = { kind: "linear" as const, ref: "https://linear.app/x/I-1" };
    expect(mailboxRefHref(linear)).toBe("https://linear.app/x/I-1");
    expect(isExternalMailboxRef(linear)).toBe(true);
    expect(isExternalMailboxRef({ kind: "task", ref: "t-1" })).toBe(false);
  });
});

describe("defaultRefLabel", () => {
  test("returns a human label for every kind, never the raw enum", () => {
    const cases = {
      artifact: "Open artifact",
      workflow_run: "Open run",
      task: "Open task",
      mail: "Open message",
      conversation: "Open chat",
      linear: "Open in Linear",
      url: "Open link",
    } as const;
    for (const [kind, label] of Object.entries(cases)) {
      const resolved = defaultRefLabel({
        kind: kind as keyof typeof cases,
        ref: "x",
      });
      expect(resolved).toBe(label);
      expect(resolved).not.toBe(kind);
    }
  });
});

describe("mailboxSenderLabel", () => {
  test("prefers fromDisplay over the raw From header", () => {
    expect(
      mailboxSenderLabel({
        from: "ins_dep@tenant.example",
        fromDisplay: "Heartbeat",
      }),
    ).toBe("Heartbeat");
    expect(mailboxSenderLabel({ from: "ins_dep@tenant.example" })).toBe(
      "ins_dep@tenant.example",
    );
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

  test("carries an optional nextCursor when present", () => {
    const payload = { messages: [goodMessage], nextCursor: "opaque" };
    expect(MailboxListResponse(payload)).toEqual(payload);
  });

  test("rejects a non-string nextCursor", () => {
    const payload = { messages: [], nextCursor: 42 };
    expect(MailboxListResponse(payload) instanceof type.errors).toBe(true);
  });

  test("rejects a list with a malformed message", () => {
    const payload = { messages: [{ id: "pm-1" }] };
    expect(MailboxListResponse(payload) instanceof type.errors).toBe(true);
  });
});
