import { describe, expect, test } from "bun:test";
import type { MessageItem } from "./api";
import {
  selectThreadFeed,
  threadAffordanceMeta,
  type ThreadActivityRow,
} from "./thread-feed";

function message(
  id: string,
  threadId: string | undefined,
  overrides?: Partial<MessageItem>,
): MessageItem {
  return {
    id,
    createdAt: `2026-08-19T10:00:0${id}Z`,
    parts: [{ kind: "text", text: id }],
    sender: { name: null, address: "alice@acme.example" },
    ...(threadId !== undefined ? { threadId } : {}),
    ...overrides,
  };
}

const ROOT = "thr_root";

describe("selectThreadFeed (CL-6313: one query, filtered by membership)", () => {
  test("root feed is root-thread membership only", () => {
    const items = [
      message("1", ROOT),
      message("2", "thr_reply"),
      message("3", ROOT),
    ];
    const feed = selectThreadFeed(items, {
      openThreadId: null,
      parentMessageId: null,
      rootThreadId: ROOT,
    });
    expect(feed.map((m) => m.id)).toEqual(["1", "3"]);
  });

  test("an open thread shows its own membership with the parent for context", () => {
    const items = [
      message("1", ROOT),
      message("2", "thr_reply"),
      message("3", "thr_reply"),
    ];
    const feed = selectThreadFeed(items, {
      openThreadId: "thr_reply",
      parentMessageId: "1",
      rootThreadId: ROOT,
    });
    expect(feed.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  test("a parent already inside the thread is never duplicated", () => {
    const items = [message("1", "thr_reply"), message("2", "thr_reply")];
    const feed = selectThreadFeed(items, {
      openThreadId: "thr_reply",
      parentMessageId: "1",
      rootThreadId: ROOT,
    });
    expect(feed.map((m) => m.id)).toEqual(["1", "2"]);
  });

  test("a brand-new reply thread shows only the message it is being started from", () => {
    const items = [message("1", ROOT), message("2", ROOT)];
    const feed = selectThreadFeed(items, {
      openThreadId: null,
      parentMessageId: "2",
      rootThreadId: ROOT,
    });
    expect(feed.map((m) => m.id)).toEqual(["2"]);
  });

  test("a message the host never stamped belongs to the root feed", () => {
    // No thread store mounted, or a message that predates membership —
    // the root thread IS the workbench feed, so unstamped is root.
    const items = [message("1", undefined), message("2", "thr_reply")];
    expect(
      selectThreadFeed(items, {
        openThreadId: null,
        parentMessageId: null,
        rootThreadId: ROOT,
      }).map((m) => m.id),
    ).toEqual(["1"]);
  });

  test("with no root thread resolved yet the full mailbox is the feed", () => {
    const items = [message("1", undefined), message("2", "thr_reply")];
    expect(
      selectThreadFeed(items, {
        openThreadId: null,
        parentMessageId: null,
        rootThreadId: "",
      }).map((m) => m.id),
    ).toEqual(["1", "2"]);
  });

  test("output is oldest-first regardless of arrival order", () => {
    const items = [message("3", ROOT), message("1", ROOT), message("2", ROOT)];
    expect(
      selectThreadFeed(items, {
        openThreadId: null,
        parentMessageId: null,
        rootThreadId: ROOT,
      }).map((m) => m.id),
    ).toEqual(["1", "2", "3"]);
  });

  test("a stale open thread id yields an empty feed rather than the wrong one", () => {
    const items = [message("1", ROOT)];
    expect(
      selectThreadFeed(items, {
        openThreadId: "thr_gone",
        parentMessageId: null,
        rootThreadId: ROOT,
      }),
    ).toEqual([]);
  });
});

describe("threadAffordanceMeta (CL-6313: counts without a request per thread)", () => {
  const rows: readonly ThreadActivityRow[] = [
    {
      id: "thr_reply",
      kind: "reply",
      parentMessageId: "1",
      replyCount: 2,
      lastActivityAt: "2026-08-19T10:00:03Z",
    },
    {
      id: ROOT,
      kind: "root",
      parentMessageId: null,
      replyCount: 5,
      lastActivityAt: "2026-08-19T10:00:09Z",
    },
  ];

  test("keys reply threads by parent message, with server counts", () => {
    const meta = threadAffordanceMeta(rows, [
      message("2", "thr_reply", {
        sender: { name: null, address: "bob@acme.example" },
      }),
      message("3", "thr_reply"),
    ]);
    expect(meta.get("1")).toEqual({
      replyCount: 2,
      lastActivityAt: "2026-08-19T10:00:03Z",
      participantAddresses: ["bob@acme.example", "alice@acme.example"],
    });
  });

  test("the root thread gets no affordance — it is the feed itself", () => {
    expect(threadAffordanceMeta(rows, []).has(ROOT)).toBe(false);
    expect(threadAffordanceMeta(rows, []).size).toBe(1);
  });

  test("a thread with no parent message is skipped rather than keyed on null", () => {
    const orphan: ThreadActivityRow = {
      id: "thr_delivery",
      kind: "delivery",
      parentMessageId: null,
      replyCount: 1,
      lastActivityAt: null,
    };
    expect(threadAffordanceMeta([orphan], []).size).toBe(0);
  });
});
