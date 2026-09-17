import { describe, expect, test } from "bun:test";
import type { MailboxThreadMessage } from "@corbits/mailbox";

import { roomRefFor, threadMessagesToTimeline } from "./mailbox-timeline";

function message(
  overrides: Partial<MailboxThreadMessage> &
    Pick<MailboxThreadMessage, "id" | "messageId">,
): MailboxThreadMessage {
  return {
    references: [],
    fromAddress: "sender@dana.localhost",
    createdAt: "2026-09-17T00:00:00.000000Z",
    read: true,
    archived: false,
    parentId: null,
    body: "hello",
    ...overrides,
  };
}

describe("threadMessagesToTimeline", () => {
  test("links a reply's threadId to its parent's own id via inReplyTo", () => {
    const parent = message({ id: "id-1", messageId: "msg-1@mail" });
    const child = message({
      id: "id-2",
      messageId: "msg-2@mail",
      inReplyTo: "msg-1@mail",
      body: "reply",
    });

    const items = threadMessagesToTimeline([parent, child]);

    expect(items[0]?.threadId).toBeUndefined();
    expect(items[1]?.threadId).toBe("id-1");
  });

  test("leaves threadId absent when the parent isn't in this batch", () => {
    const orphan = message({
      id: "id-3",
      messageId: "msg-3@mail",
      inReplyTo: "msg-missing@mail",
    });

    const [item] = threadMessagesToTimeline([orphan]);

    expect(item?.threadId).toBeUndefined();
  });
});

describe("roomRefFor", () => {
  test("stamps the same { kind: 'workbench', id } ref the mailbox writers use", () => {
    expect(roomRefFor("tenant-1", "room-1")).toEqual({
      kind: "workbench",
      id: "room-1",
    });
  });
});
