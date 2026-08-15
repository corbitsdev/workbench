import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  INBOX_GROUPS,
  InboxCountsSchema,
  InboxItemDetailSchema,
  InboxItemSchema,
  classificationFromRefs,
  inboxGroupOf,
  isInboxGroup,
  itemsEligibleForClearDone,
  itemsEligibleForMarkAllRead,
  projectInboxItem,
  type InboxItem,
} from "./client";

describe("wire schemas", () => {
  test("InboxItemSchema parses a minimal open item", () => {
    const out = InboxItemSchema({
      id: "msg_1",
      group: "delivery",
      from: "routine:morning-brief",
      date: "2026-01-01T00:00:00.000Z",
      read: false,
      status: "open",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("InboxItemDetailSchema requires a body", () => {
    const out = InboxItemDetailSchema({
      id: "msg_1",
      group: "mention",
      from: "chat:acme",
      date: "2026-01-01T00:00:00.000Z",
      read: true,
      status: "done",
      body: "You were mentioned in #general.",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("InboxCountsSchema parses the three group counts plus open", () => {
    const out = InboxCountsSchema({
      action: 1,
      mention: 2,
      delivery: 3,
      open: 6,
    });
    expect(out instanceof type.errors).toBe(false);
  });
});

describe("group classification", () => {
  test("INBOX_GROUPS is the three product groups", () => {
    expect(INBOX_GROUPS).toEqual(["action", "mention", "delivery"]);
  });

  test("isInboxGroup rejects an unknown string", () => {
    expect(isInboxGroup("action")).toBe(true);
    expect(isInboxGroup("archived")).toBe(false);
  });

  test("inboxGroupOf derives action from an approval ref", () => {
    expect(inboxGroupOf({ refs: [{ kind: "approval" }] })).toBe("action");
  });

  test("classificationFromRefs mirrors inboxGroupOf", () => {
    expect(classificationFromRefs([{ kind: "thread" }])).toBe("mention");
  });
});

describe("bulk eligibility", () => {
  const items: InboxItem[] = [
    {
      id: "1",
      group: "action",
      from: "a",
      date: "d",
      read: false,
      status: "open",
    },
    {
      id: "2",
      group: "mention",
      from: "b",
      date: "d",
      read: false,
      status: "open",
    },
    {
      id: "3",
      group: "delivery",
      from: "c",
      date: "d",
      read: true,
      status: "done",
    },
  ];

  test("mark-all-read skips action items", () => {
    expect(itemsEligibleForMarkAllRead(items).map((i) => i.id)).toEqual(["2"]);
  });

  test("clear-done only takes done items", () => {
    expect(itemsEligibleForClearDone(items).map((i) => i.id)).toEqual(["3"]);
  });
});

describe("projectInboxItem", () => {
  test("projects a mailbox message into the product InboxItem shape", () => {
    const item = projectInboxItem({
      id: "msg_1",
      from: "routine:morning-brief",
      to: ["tenant"],
      messageId: "msg_1@mailbox",
      date: "2026-01-01T00:00:00.000Z",
      read: false,
      status: "open",
    });
    expect(item.group).toBe("delivery");
  });
});
