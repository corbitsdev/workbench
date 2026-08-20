// The sidebar's recency-sorted stream: workbenches and conversational
// DMs (already persisted as `Workbench` rows). Unopened agent
// definitions do not get a synthetic row — opening a DM is a
// conversation act, not a standing nav item.

import type { Workbench } from "@corbits/chat-ui";
import { isAgentAddress } from "@corbits/chat/mentions";

export type SidebarRow = {
  readonly kind: "workbench";
  readonly workbench: Workbench;
};

/**
 * The stable identity a DM chat collapses on: an agent participant's
 * mention `handle` is the same immutable slug
 * (`buildAgentDefinitionWorkflow`'s `input.handle`) regardless which
 * ancestor tenant minted the definition, so two chats DM'ing "the same"
 * agent across tenants share this key even though their `definitionId`s
 * genuinely differ. `title` is a display-only fallback for a chat with no
 * recorded agent participant (a pre-participant-record legacy row) — never
 * the primary key, since a display title can be produced two different
 * ways for two entirely different agents (CL-6413's `humanizeSlug`
 * backfill, or simply two creators picking the same human name) and must
 * never be mistaken for identity.
 */
function agentIdentityKey(chat: Workbench): string {
  const agentParticipant = chat.participants.find((participant) =>
    isAgentAddress(participant.address),
  );
  return agentParticipant?.handle ?? chat.title;
}

/**
 * Collapse agent-DM chats down to one row per agent identity (CL-6271).
 * Shadowing already picks a single nearest definition per name in
 * `listVisibleAgentDefinitions`, but a DM chat is minted against a
 * specific definition id, so a caller who has separately DM'd the same
 * named agent (e.g. "Myra") launched from more than one ancestor tenant
 * ends up with one durable `Workbench` row per instance — the dedupe
 * there never runs again once a chat exists. Group every agent-DM chat
 * (identified by `definitionId` being set — a group workbench never
 * carries one) by `agentIdentityKey` and keep only the most recently
 * active row per group; the rest are stale siblings of an identity the
 * caller only ever needs to see once.
 */
function dedupeAgentChatsByTitle(chats: readonly Workbench[]): Workbench[] {
  const groupChats = chats.filter(
    (chat) => chat.definitionId === null || chat.definitionId === undefined,
  );
  const agentChats = chats.filter(
    (chat) => chat.definitionId !== null && chat.definitionId !== undefined,
  );

  const newestByIdentity = new Map<string, Workbench>();
  for (const chat of agentChats) {
    const key = agentIdentityKey(chat);
    const current = newestByIdentity.get(key);
    const chatActivity = chat.lastActivityAt
      ? Date.parse(chat.lastActivityAt)
      : 0;
    const currentActivity = current?.lastActivityAt
      ? Date.parse(current.lastActivityAt)
      : 0;
    if (current === undefined || chatActivity > currentActivity) {
      newestByIdentity.set(key, chat);
    }
  }

  return [...groupChats, ...newestByIdentity.values()];
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
