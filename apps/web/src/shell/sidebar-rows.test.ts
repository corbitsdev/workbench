import { describe, expect, test } from "bun:test";

import type { Workbench, VisibleAgentDefinition } from "@corbits/chat-ui";

import {
  buildSidebarRows,
  identityColorClass,
  unopenedAgentRows,
} from "./sidebar-rows";

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

function agent(
  overrides: Partial<VisibleAgentDefinition> = {},
): VisibleAgentDefinition {
  return {
    id: "wfd_outreach",
    name: "Outreach",
    tenantId: "tnt_root",
    tenantName: "Acme",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("unopenedAgentRows", () => {
  test("an agent with no existing chat gets a synthetic row", () => {
    const rows = unopenedAgentRows([], [agent()]);
    expect(rows).toEqual([{ kind: "agent", agent: agent() }]);
  });

  test("an agent already opened as a chat is never duplicated", () => {
    const chats = [
      workbench({ id: "ch_dm", kind: "chat", definitionId: "wfd_outreach" }),
    ];
    const rows = unopenedAgentRows(chats, [agent()]);
    expect(rows).toEqual([]);
  });

  test("a chat with a different definitionId doesn't suppress an unrelated agent", () => {
    const chats = [
      workbench({ id: "ch_dm", kind: "chat", definitionId: "wfd_other" }),
    ];
    const rows = unopenedAgentRows(chats, [agent()]);
    expect(rows).toEqual([{ kind: "agent", agent: agent() }]);
  });
});

describe("buildSidebarRows", () => {
  test("mixes bench and agent rows into one recency-sorted stream", () => {
    const older = workbench({
      id: "ch_old",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = workbench({
      id: "ch_new",
      kind: "chat",
      lastActivityAt: "2026-01-03T00:00:00.000Z",
    });
    const midAgent = agent({
      id: "wfd_mid",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const rows = buildSidebarRows([older], [newer], [midAgent]);

    expect(
      rows.map((row) =>
        row.kind === "workbench" ? row.workbench.id : row.agent.id,
      ),
    ).toEqual(["ch_new", "wfd_mid", "ch_old"]);
  });

  test("pinned workbench rows float above every unpinned row regardless of recency", () => {
    const pinned = workbench({
      id: "ch_pinned",
      pinned: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const freshAgent = agent({
      id: "wfd_fresh",
      createdAt: "2026-01-05T00:00:00.000Z",
    });

    const rows = buildSidebarRows([pinned], [], [freshAgent]);

    expect(rows[0]).toEqual({ kind: "workbench", workbench: pinned });
  });

  test("an agent already opened as a DM appears once, as its workbench row", () => {
    const dm = workbench({
      id: "ch_dm",
      kind: "chat",
      definitionId: "wfd_outreach",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });

    const rows = buildSidebarRows([], [dm], [agent()]);

    expect(rows).toEqual([{ kind: "workbench", workbench: dm }]);
  });

  test("DMs with the same agent identity minted from different ancestor tenants collapse to the most recent one (CL-6271)", () => {
    const staleDm = workbench({
      id: "ch_myra_ancestor",
      kind: "chat",
      title: "Myra",
      definitionId: "wfd_myra_ancestor",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const freshDm = workbench({
      id: "ch_myra_leaf",
      kind: "chat",
      title: "Myra",
      definitionId: "wfd_myra_leaf",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });

    const rows = buildSidebarRows([], [staleDm, freshDm], []);

    expect(rows).toEqual([{ kind: "workbench", workbench: freshDm }]);
  });

  test("group workbenches are never mistaken for agent DMs during dedupe", () => {
    const groupOne = workbench({ id: "ch_group_1", title: "Launch plan" });
    const groupTwo = workbench({ id: "ch_group_2", title: "Launch plan" });

    const rows = buildSidebarRows([], [groupOne, groupTwo], []);

    expect(rows.map((row) => (row.kind === "workbench" ? row.workbench.id : null))).toEqual([
      "ch_group_1",
      "ch_group_2",
    ]);
  });
});

describe("identityColorClass", () => {
  test("is deterministic for the same name", () => {
    expect(identityColorClass("Outreach")).toBe(identityColorClass("Outreach"));
  });

  test("returns one of the five brand-compatible buckets", () => {
    const classes = ["Outreach", "Researcher", "Myra", "Echo", "Assist"].map(
      identityColorClass,
    );
    for (const cls of classes) {
      expect(cls).toMatch(/^shell-agent-color-[0-4]$/);
    }
  });

  test("different names can land in different buckets", () => {
    const classes = new Set(
      ["Outreach", "Researcher", "Myra", "Echo", "Assist"].map(
        identityColorClass,
      ),
    );
    expect(classes.size).toBeGreaterThan(1);
  });
});
