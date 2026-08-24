import { describe, expect, test } from "bun:test";

import type { Workbench } from "@corbits/chat-ui";

import type { SidebarRow, SidebarSection } from "./sidebar-rows";
import { buildSidebarSections } from "./sidebar-rows";
import {
  filterSidebarRows,
  filterSidebarSections,
  orderWorkbenchRows,
  renamePayload,
  rowMenuLabels,
  sidebarSectionEmptyCopy,
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

function row(overrides: Partial<Workbench> = {}): SidebarRow {
  return { kind: "workbench", workbench: workbench(overrides) };
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

describe("filterSidebarRows", () => {
  // CL-6662: the row shows title + preview; search must match either, or a
  // query visible in the preview (e.g. "Solvora") falsely returns no matches.
  test("matches the displayed title", () => {
    const rows = [
      row({ id: "ch_a", title: "Launch plan" }),
      row({ id: "ch_b", title: "Research brief" }),
    ];
    expect(
      filterSidebarRows(rows, "launch").map((r) => r.workbench.id),
    ).toEqual(["ch_a"]);
  });

  test("matches preview text even when the title does not (CL-6662)", () => {
    const rows = [
      row({
        id: "ch_solvora",
        title: "Myra",
        preview: "Drafted the Solvora outreach email",
      }),
      row({
        id: "ch_other",
        title: "Scout",
        preview: "Weekly digest ready",
      }),
    ];
    expect(
      filterSidebarRows(rows, "Solvora").map((r) => r.workbench.id),
    ).toEqual(["ch_solvora"]);
  });

  test("is case-insensitive across title and preview", () => {
    const rows = [
      row({ id: "ch_1", title: "Myra", preview: "Talked about Acme pricing" }),
    ];
    expect(filterSidebarRows(rows, "ACME").map((r) => r.workbench.id)).toEqual([
      "ch_1",
    ]);
    expect(filterSidebarRows(rows, "myra").map((r) => r.workbench.id)).toEqual([
      "ch_1",
    ]);
  });

  test("an empty or whitespace-only query returns every row", () => {
    const rows = [row({ id: "ch_a" }), row({ id: "ch_b", title: "Other" })];
    expect(filterSidebarRows(rows, "").map((r) => r.workbench.id)).toEqual([
      "ch_a",
      "ch_b",
    ]);
    expect(filterSidebarRows(rows, "   ").map((r) => r.workbench.id)).toEqual([
      "ch_a",
      "ch_b",
    ]);
  });

  test("returns no rows when neither title nor preview matches", () => {
    const rows = [row({ id: "ch_1", title: "Myra", preview: "Hello there" })];
    expect(filterSidebarRows(rows, "zzz")).toEqual([]);
  });

  test("a missing preview still matches on title alone", () => {
    const rows = [row({ id: "ch_1", title: "Launch plan" })];
    expect(
      filterSidebarRows(rows, "launch").map((r) => r.workbench.id),
    ).toEqual(["ch_1"]);
  });
});

describe("sidebarSectionEmptyCopy", () => {
  test("names the empty group, never a single workbenches list", () => {
    expect(sidebarSectionEmptyCopy("agents")).toBe("No agents yet");
    expect(sidebarSectionEmptyCopy("channels")).toBe("No channels yet");
  });
});

describe("filterSidebarSections", () => {
  test("filters Agents and Channels independently without mixing them", () => {
    const sections = buildSidebarSections(
      [
        workbench({
          id: "ch_room",
          kind: "workbench",
          title: "Launch plan",
        }),
      ],
      [
        workbench({
          id: "ch_dm",
          kind: "chat",
          title: "Myra",
          preview: "Drafted the Solvora outreach email",
        }),
      ],
    );
    const byTitle = filterSidebarSections(sections, "launch");
    expect(byTitle.map((section) => section.id)).toEqual([
      "agents",
      "channels",
    ]);
    expect(byTitle[0]?.rows.map((r) => r.workbench.id)).toEqual([]);
    expect(byTitle[1]?.rows.map((r) => r.workbench.id)).toEqual(["ch_room"]);

    const byPreview = filterSidebarSections(sections, "Solvora");
    expect(byPreview[0]?.rows.map((r) => r.workbench.id)).toEqual(["ch_dm"]);
    expect(byPreview[1]?.rows.map((r) => r.workbench.id)).toEqual([]);
  });

  test("an empty query keeps both sections intact", () => {
    const sections: readonly SidebarSection[] = buildSidebarSections(
      [workbench({ id: "ch_room", kind: "workbench", title: "Launch" })],
      [workbench({ id: "ch_dm", kind: "chat", title: "Myra" })],
    );
    expect(filterSidebarSections(sections, "")).toEqual(sections);
  });
});
