// The sidebar's two lists: Agents (`kind: "chat"` DMs, including Myra's
// once opened) and Channels (`kind: "workbench"` rooms). Recency and pin
// order apply within each section, never across. Unopened agent
// definitions do not get a synthetic row — opening a DM is a
// conversation act, not a standing nav item.

import type { Workbench } from "@corbits/chat-ui";

export type SidebarRow = {
  readonly kind: "workbench";
  readonly workbench: Workbench;
};

export type SidebarSectionId = "agents" | "channels";

export type SidebarSection = {
  readonly id: SidebarSectionId;
  readonly label: "Agents" | "Channels";
  readonly rows: readonly SidebarRow[];
};

function activityOf(chat: Workbench): number {
  return chat.lastActivityAt ? Date.parse(chat.lastActivityAt) : 0;
}

function recencyOf(row: SidebarRow): number {
  return activityOf(row.workbench);
}

function isPinned(row: SidebarRow): boolean {
  return row.workbench.pinned;
}

/**
 * Pinned first, then most-recent first within each half. Stable within
 * ties. Same rule `orderWorkbenchRows` applies to a single list.
 */
export function buildSidebarRows(
  items: readonly Workbench[],
): readonly SidebarRow[] {
  // Every row a person can see in Postgres appears here. An earlier
  // heuristic (CL-6271) collapsed same-agent chats onto the newest
  // definitionId to hide stale cross-tenant DM siblings; once creation
  // began cloning a fresh definition per workbench (CL-6452), that
  // heuristic could no longer tell a stale sibling from a deliberately
  // created workbench and hid every workbench but the newest (CL-6621).
  // Hiding real workbenches reads as data loss; a duplicate stale DM is
  // merely untidy. If stale siblings resurface, fix them server-side at
  // list time, not with a client-side identity guess.
  const rows: SidebarRow[] = items.map(
    (workbench) => ({ kind: "workbench", workbench }) as const,
  );
  const byRecency = (a: SidebarRow, b: SidebarRow) =>
    recencyOf(b) - recencyOf(a);
  return [
    ...rows.filter(isPinned).sort(byRecency),
    ...rows.filter((row) => !isPinned(row)).sort(byRecency),
  ];
}

/**
 * Two labeled sections over the existing workbench / chat listings.
 * Split by `workbench.kind` so a row that arrived in the other fetch
 * still lands in the right group. Agents always precede Channels;
 * recency never lifts a channel above the Agents heading.
 */
export function buildSidebarSections(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
): readonly SidebarSection[] {
  const listed = [...workbenches, ...chats];
  return [
    {
      id: "agents",
      label: "Agents",
      rows: buildSidebarRows(listed.filter((item) => item.kind === "chat")),
    },
    {
      id: "channels",
      label: "Channels",
      rows: buildSidebarRows(
        listed.filter((item) => item.kind === "workbench"),
      ),
    },
  ];
}
