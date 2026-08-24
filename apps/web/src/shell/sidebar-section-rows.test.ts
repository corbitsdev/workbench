import { describe, expect, test } from "bun:test";

import type { VisibleAgentDefinition, Workbench } from "@corbits/chat-ui";

import { buildSidebarSections } from "./sidebar-section-rows";

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

function definition(
  overrides: Partial<VisibleAgentDefinition> = {},
): VisibleAgentDefinition {
  return {
    id: "wfd_myra",
    name: "Myra",
    tenantId: "tnt_1",
    tenantName: "Acme",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSidebarSections", () => {
  test("projects agent chats and rooms into separate sections", () => {
    const agentChat = workbench({
      id: "ch_agent",
      kind: "chat",
      definitionId: "wfd_myra",
    });
    const room = workbench({ id: "ch_room" });

    const sections = buildSidebarSections([room], [agentChat], []);

    expect(sections.agents).toEqual([
      { kind: "persisted", workbench: agentChat },
    ]);
    expect(sections.channels).toEqual([room]);
  });

  test("adds unopened visible definitions but not a standing row for an exact persisted definition", () => {
    const opened = definition({ id: "wfd_opened", name: "Opened" });
    const unopened = definition({ id: "wfd_unopened", name: "Unopened" });
    const chat = workbench({
      id: "ch_opened",
      kind: "chat",
      definitionId: opened.id,
      lastActivityAt: "2026-01-03T00:00:00.000Z",
    });

    const sections = buildSidebarSections([], [chat], [opened, unopened]);

    expect(sections.agents).toEqual([
      { kind: "persisted", workbench: chat },
      { kind: "definition", definition: unopened },
    ]);
  });

  test("excludes human DMs from Agents", () => {
    const humanDm = workbench({
      id: "ch_human",
      kind: "chat",
      principalId: "prn_2",
    });

    expect(buildSidebarSections([], [humanDm], []).agents).toEqual([]);
  });

  test("floats pinned persisted rows only inside their own section", () => {
    const oldPinnedAgent = workbench({
      id: "ch_agent_pinned",
      kind: "chat",
      definitionId: "wfd_pinned",
      pinned: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const recentAgent = workbench({
      id: "ch_agent_recent",
      kind: "chat",
      definitionId: "wfd_recent",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });
    const oldPinnedRoom = workbench({
      id: "ch_room_pinned",
      pinned: true,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const recentRoom = workbench({
      id: "ch_room_recent",
      lastActivityAt: "2026-01-05T00:00:00.000Z",
    });

    const sections = buildSidebarSections(
      [recentRoom, oldPinnedRoom],
      [recentAgent, oldPinnedAgent],
      [],
    );

    expect(
      sections.agents.map((row) =>
        row.kind === "persisted" ? row.workbench.id : row.definition.id,
      ),
    ).toEqual(["ch_agent_pinned", "ch_agent_recent"]);
    expect(sections.channels.map((row) => row.id)).toEqual([
      "ch_room_pinned",
      "ch_room_recent",
    ]);
  });

  test("never collapses persisted chats by title or by a different definition id", () => {
    const chats = [
      workbench({
        id: "ch_one",
        kind: "chat",
        title: "Assistant",
        definitionId: "wfd_one",
      }),
      workbench({
        id: "ch_two",
        kind: "chat",
        title: "Assistant",
        definitionId: "wfd_two",
      }),
    ];

    const sections = buildSidebarSections([], chats, [
      definition({ id: "wfd_three", name: "Assistant" }),
    ]);

    expect(sections.agents).toHaveLength(3);
  });
});
