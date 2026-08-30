import { describe, expect, test } from "bun:test";
import type { MailboxPage } from "@corbits/mailbox";
import { encodeMailboxListCursor } from "@corbits/mailbox";
import { IncompleteWalkError, walkAllOpen } from "../src/walk";

function message(id: string, createdAt: string) {
  return {
    id,
    messageId: `${id}@test`,
    from: "routine:test",
    to: ["prn_1@inbox.test"],
    date: createdAt,
    read: false,
    status: "open" as const,
    createdAt,
  };
}

const SHAPE = { view: "all" as const, sort: "date" as const, filter: "" };

describe("walkAllOpen", () => {
  test("walks every page and stops once nextCursor is undefined", async () => {
    let calls = 0;
    const page: MailboxPage = {
      items: [message("msg_1", "2026-01-02T00:00:00.000000Z")],
    };
    const items = await walkAllOpen(async () => {
      calls += 1;
      return page;
    });
    expect(items.map((item) => item.id)).toEqual(["msg_1"]);
    expect(calls).toBe(1);
  });

  test("follows nextCursor across multiple pages", async () => {
    const cursorFor = (id: string, createdAt: string) =>
      encodeMailboxListCursor({ createdAt, id }, SHAPE);
    const pages: MailboxPage[] = [
      {
        items: [message("msg_1", "2026-01-03T00:00:00.000000Z")],
        nextCursor: cursorFor("msg_1", "2026-01-03T00:00:00.000000Z"),
      },
      { items: [message("msg_2", "2026-01-02T00:00:00.000000Z")] },
    ];
    let call = 0;
    const items = await walkAllOpen(async () => {
      const page = pages[call];
      call += 1;
      if (page === undefined) throw new Error("listPage called too many times");
      return page;
    });
    expect(items.map((item) => item.id)).toEqual(["msg_1", "msg_2"]);
    expect(call).toBe(2);
  });

  test("throws IncompleteWalkError when the next cursor is undecodable", async () => {
    const page: MailboxPage = {
      items: [message("msg_1", "2026-01-01T00:00:00.000000Z")],
      nextCursor: "not-a-valid-cursor",
    };
    await expect(walkAllOpen(async () => page)).rejects.toBeInstanceOf(
      IncompleteWalkError,
    );
  });

  test("throws IncompleteWalkError when the cursor does not advance", async () => {
    const stuckCursor = encodeMailboxListCursor(
      { createdAt: "2026-01-01T00:00:00.000000Z", id: "msg_1" },
      SHAPE,
    );
    const page: MailboxPage = {
      items: [message("msg_1", "2026-01-01T00:00:00.000000Z")],
      nextCursor: stuckCursor,
    };
    // Every call returns the exact same page/cursor — an infinite loop
    // without the advance guard.
    await expect(walkAllOpen(async () => page)).rejects.toBeInstanceOf(
      IncompleteWalkError,
    );
  });

  test("throws IncompleteWalkError once maxPages is exceeded", async () => {
    let call = 0;
    const listPage = async (): Promise<MailboxPage> => {
      call += 1;
      return {
        items: [message(`msg_${call}`, `2026-01-01T00:00:0${call}.000000Z`)],
        nextCursor: encodeMailboxListCursor(
          { createdAt: `2026-01-01T00:00:0${call}.000000Z`, id: `msg_${call}` },
          SHAPE,
        ),
      };
    };
    await expect(walkAllOpen(listPage, { maxPages: 2 })).rejects.toBeInstanceOf(
      IncompleteWalkError,
    );
    expect(call).toBe(2);
  });
});
