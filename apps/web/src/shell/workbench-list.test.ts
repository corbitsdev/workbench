import { describe, expect, test } from "bun:test";

import type { Workbench } from "@corbits/chat-ui";

import {
  orderWorkbenchRows,
  renamePayload,
  rowMenuLabels,
  workbenchRowSignals,
} from "./workbench-list";

function workbench(overrides: Partial<Workbench> = {}): Workbench {
  return {
    id: "ch_1",
    title: "Myra",
    kind: "chat",
    pinned: false,
    participants: [],
    ...overrides,
  } as Workbench;
}

describe("rowMenuLabels", () => {
  test("offers Pin for an unpinned row and Unpin for a pinned one", () => {
    expect(rowMenuLabels({ pinned: false })).toEqual(["Rename", "Pin"]);
    expect(rowMenuLabels({ pinned: true })).toEqual(["Rename", "Unpin"]);
  });
});

describe("renamePayload", () => {
  test("trims and returns a changed name", () => {
    expect(renamePayload("  Deep Research  ", "Myra")).toBe("Deep Research");
  });

  test("returns undefined for blank input", () => {
    expect(renamePayload("   ", "Myra")).toBeUndefined();
  });

  test("returns undefined for an unchanged name", () => {
    expect(renamePayload("Myra", "Myra")).toBeUndefined();
  });
});

describe("workbenchRowSignals", () => {
  test("passes through only the signals the platform actually sent", () => {
    expect(workbenchRowSignals(workbench(), false)).toEqual({});
    const signals = workbenchRowSignals(
      workbench({ unreadCount: 3, live: true, sharedLabel: "Acme" }),
      false,
    );
    expect(signals.unread).toBe(3);
    expect(signals.live).toBe(true);
    expect(signals.sharedLabel).toBe("Acme");
  });

  test("an open workbench never shows a stale unread badge", () => {
    expect(
      workbenchRowSignals(workbench({ unreadCount: 5 }), true).unread,
    ).toBe(0);
  });
});

describe("orderWorkbenchRows", () => {
  test("floats pinned rows to the top, keeping each half's given order", () => {
    const rows = [
      workbench({ id: "a" }),
      workbench({ id: "b", pinned: true }),
      workbench({ id: "c" }),
      workbench({ id: "d", pinned: true }),
    ];
    expect(orderWorkbenchRows(rows).map((row) => row.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  test("orders most-recent activity first within each half", () => {
    const rows = [
      workbench({ id: "old", lastActivityAt: "2026-08-01T00:00:00Z" }),
      workbench({ id: "new", lastActivityAt: "2026-08-10T00:00:00Z" }),
      workbench({
        id: "pinned-old",
        pinned: true,
        lastActivityAt: "2026-08-01T00:00:00Z",
      }),
      workbench({
        id: "pinned-new",
        pinned: true,
        lastActivityAt: "2026-08-10T00:00:00Z",
      }),
    ];
    expect(orderWorkbenchRows(rows).map((row) => row.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "new",
      "old",
    ]);
  });

  test("never groups by kind — a flat list in, a flat list out", () => {
    const rows = [
      workbench({ id: "a", kind: "chat" }),
      workbench({ id: "b", kind: "workbench" }),
      workbench({ id: "c", kind: "chat" }),
    ];
    expect(orderWorkbenchRows(rows).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
