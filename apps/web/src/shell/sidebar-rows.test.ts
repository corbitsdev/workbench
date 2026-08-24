import { describe, expect, test } from "bun:test";

import type { Workbench } from "@corbits/chat-ui";

import { buildSidebarRows } from "./sidebar-rows";
import type { SidebarRow } from "./sidebar-rows";

function workbench(overrides: Partial<Workbench> = {}): Workbench {
  return {
    id: "ch_1",
    title: "General",
    kind: "workbench",
    pinned: false,
    participants: [],
    ...overrides,
  } as Workbench;
}

function idsOf(rows: readonly SidebarRow[]): readonly string[] {
  return rows.map((row) => row.workbench.id);
}

function mix(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
): readonly SidebarRow[] {
  return buildSidebarRows([...workbenches, ...chats]);
}

describe("buildSidebarRows", () => {
  test("kind:chat and kind:workbench share one list, with kind kept on each workbench", () => {
    const channel = workbench({
      id: "ch_room",
      kind: "workbench",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const dm = workbench({
      id: "ch_dm",
      kind: "chat",
      lastActivityAt: "2026-01-02T00:00:00.000Z",
    });

    const rows = mix([channel], [dm]);

    expect(idsOf(rows)).toEqual(["ch_dm", "ch_room"]);
    expect(rows.map((row) => row.workbench.kind)).toEqual([
      "chat",
      "workbench",
    ]);
    expect(rows.every((row) => row.kind === "workbench")).toBe(true);
  });

  test("mixed recency interleaves — a newer channel sits above an older DM", () => {
    const olderDm = workbench({
      id: "ch_dm",
      kind: "chat",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const newerChannel = workbench({
      id: "ch_room",
      kind: "workbench",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });

    const rows = mix([newerChannel], [olderDm]);

    expect(idsOf(rows)).toEqual(["ch_room", "ch_dm"]);
  });

  test("never synthesizes a row for an agent that has not been opened as a DM", () => {
    const older = workbench({
      id: "ch_old",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });

    const rows = mix([older], []);

    expect(idsOf(rows)).toEqual(["ch_old"]);
    expect(rows).toEqual([{ kind: "workbench", workbench: older }]);
  });

  test("pinned floats across the mixed list, not within a kind", () => {
    const pinnedChannel = workbench({
      id: "ch_pinned_room",
      kind: "workbench",
      pinned: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const recentChannel = workbench({
      id: "ch_recent_room",
      kind: "workbench",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });
    const pinnedDm = workbench({
      id: "ch_pinned_dm",
      kind: "chat",
      pinned: true,
      lastActivityAt: "2026-01-02T00:00:00.000Z",
    });
    const recentDm = workbench({
      id: "ch_recent_dm",
      kind: "chat",
      lastActivityAt: "2026-01-04T00:00:00.000Z",
    });

    const rows = mix([pinnedChannel, recentChannel], [recentDm, pinnedDm]);

    expect(idsOf(rows)).toEqual([
      "ch_pinned_dm",
      "ch_pinned_room",
      "ch_recent_room",
      "ch_recent_dm",
    ]);
  });

  test("an agent already opened as a DM appears once, as its workbench row", () => {
    const dm = workbench({
      id: "ch_dm",
      kind: "chat",
      definitionId: "wfd_outreach",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });

    const rows = mix([], [dm]);

    expect(rows).toEqual([{ kind: "workbench", workbench: dm }]);
  });

  test("every created workbench keeps its row even when each minted its own definition (CL-6621)", () => {
    // Creation now clones a fresh definition per workbench (CL-6452), so
    // sibling rows for the same agent legitimately carry distinct
    // definitionIds. The old CL-6271 collapse keyed on exactly that and
    // hid every workbench but the newest — a person creating a second
    // workbench watched the first vanish.
    const created = ["ch_new_1", "ch_new_2", "ch_new_3"].map((id, index) =>
      workbench({
        id,
        kind: "chat",
        title: "New Workbench",
        definitionId: `wfd_myra_${id}`,
        participants: [{ address: "myra@acme.localhost", handle: "myra" }],
        lastActivityAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      }),
    );

    const rows = mix([], created);

    expect(idsOf(rows)).toEqual(["ch_new_3", "ch_new_2", "ch_new_1"]);
  });

  test("two distinct agents whose slugs humanize to the same title never collapse into one row (CL-6413)", () => {
    const researchAnalystHyphen = workbench({
      id: "ch_research_analyst_hyphen",
      kind: "chat",
      title: "Research Analyst",
      definitionId: "wfd_research_analyst_hyphen",
      participants: [
        {
          address: "research-analyst@acme.localhost",
          handle: "research-analyst",
        },
      ],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const researchAnalystUnderscore = workbench({
      id: "ch_research_analyst_underscore",
      kind: "chat",
      title: "Research Analyst",
      definitionId: "wfd_research_analyst_underscore",
      participants: [
        {
          address: "research_analyst@acme.localhost",
          handle: "research_analyst",
        },
      ],
      lastActivityAt: "2026-01-02T00:00:00.000Z",
    });

    const rows = mix([], [researchAnalystHyphen, researchAnalystUnderscore]);

    expect([...idsOf(rows)].sort()).toEqual([
      "ch_research_analyst_hyphen",
      "ch_research_analyst_underscore",
    ]);
  });

  test("same-titled DMs both stay: a title is not identity (CL-6621)", () => {
    const olderDm = workbench({
      id: "ch_legacy_ancestor",
      kind: "chat",
      title: "Assist",
      definitionId: "wfd_legacy_ancestor",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const newerDm = workbench({
      id: "ch_legacy_leaf",
      kind: "chat",
      title: "Assist",
      definitionId: "wfd_legacy_leaf",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });

    const rows = mix([], [olderDm, newerDm]);

    expect(idsOf(rows)).toEqual(["ch_legacy_leaf", "ch_legacy_ancestor"]);
  });

  test("group workbenches with identical titles each keep their row", () => {
    const groupOne = workbench({ id: "ch_group_1", title: "Launch plan" });
    const groupTwo = workbench({ id: "ch_group_2", title: "Launch plan" });

    const rows = mix([groupOne, groupTwo], []);

    expect(idsOf(rows)).toEqual(["ch_group_1", "ch_group_2"]);
  });

  test("concatenates both fetches without re-bucketing by kind", () => {
    const misplacedChannel = workbench({
      id: "ch_room",
      kind: "workbench",
    });
    const misplacedDm = workbench({
      id: "ch_dm",
      kind: "chat",
    });

    const rows = mix([misplacedDm], [misplacedChannel]);

    expect(idsOf(rows)).toEqual(["ch_dm", "ch_room"]);
    expect(rows[0]?.workbench.kind).toBe("chat");
    expect(rows[1]?.workbench.kind).toBe("workbench");
  });
});
