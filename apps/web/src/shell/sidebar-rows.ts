// The sidebar's one recency list: opened agent DMs (`kind: "chat"`,
// including Myra's once opened) mixed with channels (`kind: "workbench"`).
// Pinned first, then recency — across kinds, never two labeled sections.
// Unopened agent definitions do not get a synthetic row — opening a DM is
// a conversation act, not a standing nav item.

import type { Workbench } from "@corbits/chat-ui";

export type SidebarRow = {
  readonly kind: "workbench";
  readonly workbench: Workbench;
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
 * ties. Same rule `orderWorkbenchRows` applies to a single list. Concatenate
 * the kind:chat and kind:workbench fetches, then sort here — do not split
 * by kind.
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
