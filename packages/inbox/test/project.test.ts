import { describe, expect, test } from "bun:test";

import type { MailboxMessage } from "@corbits/mailbox";

import { projectInboxItem } from "../src/project";

function message(over: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "m1",
    from: "agent:ops",
    to: ["user:u1"],
    date: "2026-08-10T12:00:00.000Z",
    messageId: "<m1@test.local>",
    read: false,
    ...over,
  };
}

describe("projectInboxItem", () => {
  test("maps an approval-ref message into the action group", () => {
    const item = projectInboxItem(
      message({
        subject: "Approve deploy",
        status: "open",
        refs: [{ kind: "approval", id: "appr-1", label: "Deploy" }],
      }),
    );
    expect(item.group).toBe("action");
    expect(item.status).toBe("open");
    expect(item.subject).toBe("Approve deploy");
    expect(item.refs?.[0]?.kind).toBe("approval");
  });

  test("maps classification delivery + open status", () => {
    const item = projectInboxItem(
      message({ classification: "delivery", status: "open" }),
    );
    expect(item.group).toBe("delivery");
    expect(item.status).toBe("open");
  });

  test("unknown status falls back to open", () => {
    const item = projectInboxItem(message({ status: "weird" }));
    expect(item.status).toBe("open");
  });
});
