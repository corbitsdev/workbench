import { describe, expect, test } from "bun:test";
import type { MailboxListCursor } from "@corbits/mailbox";
import { cursorScopeMismatch } from "../src/cursor";

function cursor(overrides: Partial<MailboxListCursor> = {}): MailboxListCursor {
  return {
    createdAt: "2026-01-01T00:00:00.000000Z",
    id: "msg_1",
    view: "all",
    sort: "date",
    filter: "classification=action",
    ...overrides,
  };
}

describe("cursorScopeMismatch", () => {
  test("matching cursor: no mismatch", () => {
    const mismatch = cursorScopeMismatch(cursor(), {
      view: "all",
      sort: "date",
      filter: { classification: "action" },
    });
    expect(mismatch).toBeNull();
  });

  test("cursor minted under a different group filter is rejected", () => {
    // Paged `?group=action`, then replayed that cursor under `?group=mention`.
    const actionCursor = cursor({ filter: "classification=action" });
    const mismatch = cursorScopeMismatch(actionCursor, {
      view: "all",
      sort: "date",
      filter: { classification: "mention" },
    });
    expect(mismatch).toBe("filter");
  });

  test("cursor minted under a different view is rejected", () => {
    const mismatch = cursorScopeMismatch(cursor({ view: "unread" }), {
      view: "all",
      sort: "date",
      filter: {},
    });
    expect(mismatch).toBe("view");
  });

  test("cursor minted under a different sort is rejected", () => {
    const mismatch = cursorScopeMismatch(cursor({ sort: "priority" }), {
      view: "all",
      sort: "date",
      filter: {},
    });
    expect(mismatch).toBe("sort");
  });

  test("view is checked before sort and filter", () => {
    const mismatch = cursorScopeMismatch(
      cursor({ view: "unread", sort: "priority", filter: "status=done" }),
      { view: "all", sort: "date", filter: {} },
    );
    expect(mismatch).toBe("view");
  });
});
