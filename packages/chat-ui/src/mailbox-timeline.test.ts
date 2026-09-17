import { describe, expect, test } from "bun:test";

import { threadTreeToTimeline } from "./mailbox-timeline";

function envelope(overrides: {
  messageId: string;
  from?: string;
  subject?: string;
  date?: string;
}) {
  return {
    messageId: overrides.messageId,
    from: overrides.from ?? "sender@dana.localhost",
    to: [],
    subject: overrides.subject ?? "",
    date: overrides.date ?? "2026-09-17T00:00:00.000Z",
    references: [],
  };
}

describe("threadTreeToTimeline", () => {
  test("links a reply's threadId to its parent's own uid", () => {
    const root = {
      uid: 1,
      flags: [],
      envelope: envelope({ messageId: "<msg-1@mail>" }),
      children: [
        {
          uid: 2,
          flags: [],
          envelope: envelope({ messageId: "<msg-2@mail>", subject: "reply" }),
          children: [],
        },
      ],
    };

    const items = threadTreeToTimeline(root);

    expect(items[0]?.threadId).toBeUndefined();
    expect(items[1]?.threadId).toBe("1");
  });

  test("a single-node thread has no threadId at all", () => {
    const root = {
      uid: 3,
      flags: [],
      envelope: envelope({ messageId: "<msg-3@mail>" }),
      children: [],
    };

    const [item] = threadTreeToTimeline(root);

    expect(item?.threadId).toBeUndefined();
  });
});
