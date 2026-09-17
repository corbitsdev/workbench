// CL-6660: `ensureReplyThreadRow` is the pure fold `use-optimistic-sends.ts`
// calls to seed (or bump) a reply-thread row in the threads cache before
// navigation opens it. The `chat.message`/`chat.reaction`/`chat.pin` stream
// cache-application this file used to cover was retired with CL-8174 slice
// 2b — the feed now reads via `@corbits/mailbox`'s thread routes, and pins
// and reactions have no mailbox equivalent, so `applyStreamMessage`,
// `applyStreamReaction`, and `applyStreamPin` no longer exist.

import { describe, expect, test } from "bun:test";

import { ensureReplyThreadRow } from "../src/use-workbench-feed";
import type { WorkbenchThreadRow } from "../src/api";

describe("ensureReplyThreadRow (CL-6660)", () => {
  const empty: {
    readonly rootThreadId: string;
    readonly items: readonly WorkbenchThreadRow[];
  } = { rootThreadId: "root", items: [] };

  test("seeds a missing reply-thread row with parentMessageId and replyCount 1", () => {
    const next = ensureReplyThreadRow(empty, {
      threadId: "thr_new",
      createdAt: "2026-01-01T00:01:00.000Z",
      parentMessageId: "m_parent",
    });
    expect(next.items).toEqual([
      {
        id: "thr_new",
        kind: "reply",
        parentMessageId: "m_parent",
        parentThreadId: "root",
        runRef: null,
        title: null,
        createdAt: "2026-01-01T00:01:00.000Z",
        replyCount: 1,
        lastActivityAt: "2026-01-01T00:01:00.000Z",
      },
    ]);
  });

  test("fills a null parentMessageId on an existing stub without overwriting a real parent", () => {
    const withStub = ensureReplyThreadRow(empty, {
      threadId: "thr_new",
      createdAt: "2026-01-01T00:01:00.000Z",
      bumpReplyCount: false,
    });
    expect(withStub.items[0]?.parentMessageId).toBeNull();
    expect(withStub.items[0]?.replyCount).toBe(0);

    const filled = ensureReplyThreadRow(withStub, {
      threadId: "thr_new",
      createdAt: "2026-01-01T00:02:00.000Z",
      parentMessageId: "m_parent",
      bumpReplyCount: false,
    });
    expect(filled.items[0]?.parentMessageId).toBe("m_parent");

    const kept = ensureReplyThreadRow(filled, {
      threadId: "thr_new",
      createdAt: "2026-01-01T00:03:00.000Z",
      parentMessageId: "m_other",
      bumpReplyCount: false,
    });
    expect(kept.items[0]?.parentMessageId).toBe("m_parent");
  });
});
