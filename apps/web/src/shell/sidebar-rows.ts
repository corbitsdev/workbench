// The sidebar's recency-sorted stream: workbenches and conversational
// DMs (already persisted as `Workbench` rows). Unopened agent
// definitions do not get a synthetic row — opening a DM is a
// conversation act, not a standing nav item.

import type { Workbench } from "@corbits/chat-ui";

export type SidebarRow = {
  readonly kind: "workbench";
  readonly workbench: Workbench;
};

/**
 * Collapse agent-DM chats down to one row per agent identity (CL-6271).
 * Shadowing already picks a single nearest definition per name in
 * `listVisibleAgentDefinitions`, but a DM chat is minted against a
 * specific definition id, so a caller who has separately DM'd the same
 * named agent (e.g. "Myra") launched from more than one ancestor tenant
 * ends up with one durable `Workbench` row per instance — the dedupe
 * there never runs again once a chat exists. Group every agent-DM chat
 * (identified by `definitionId` being set — a group workbench never
 * carries one) by its title and keep only the most recently active row
 * per group; the rest are stale siblings of an identity the caller only
 * ever needs to see once.
 */
function dedupeAgentChatsByTitle(chats: readonly Workbench[]): Workbench[] {
  const groupChats = chats.filter(
    (chat) => chat.definitionId === null || chat.definitionId === undefined,
  );
  const agentChats = chats.filter(
    (chat) => chat.definitionId !== null && chat.definitionId !== undefined,
  );

  const newestByTitle = new Map<string, Workbench>();
  for (const chat of agentChats) {
    const current = newestByTitle.get(chat.title);
    const chatActivity = chat.lastActivityAt
      ? Date.parse(chat.lastActivityAt)
      : 0;
    const currentActivity = current?.lastActivityAt
      ? Date.parse(current.lastActivityAt)
      : 0;
    if (current === undefined || chatActivity > currentActivity) {
      newestByTitle.set(chat.title, chat);
    }
  }

  return [...groupChats, ...newestByTitle.values()];
}

function recencyOf(row: SidebarRow): number {
  return row.workbench.lastActivityAt
    ? Date.parse(row.workbench.lastActivityAt)
    : 0;
}

function isPinned(row: SidebarRow): boolean {
  return row.workbench.pinned;
}

/**
 * Every workbench plus every conversational DM, pinned first, then
 * most-recent first within each half — the same ordering rule
 * `orderWorkbenchRows` applies to workbenches alone, widened to the
 * union. Stable within ties.
 */
export function buildSidebarRows(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
): readonly SidebarRow[] {
  const dedupedChats = dedupeAgentChatsByTitle(chats);
  const rows: SidebarRow[] = [
    ...workbenches.map(
      (workbench) => ({ kind: "workbench", workbench }) as const,
    ),
    ...dedupedChats.map(
      (workbench) => ({ kind: "workbench", workbench }) as const,
    ),
  ];
  const byRecency = (a: SidebarRow, b: SidebarRow) =>
    recencyOf(b) - recencyOf(a);
  return [
    ...rows.filter(isPinned).sort(byRecency),
    ...rows.filter((row) => !isPinned(row)).sort(byRecency),
  ];
}
