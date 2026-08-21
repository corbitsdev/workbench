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

type AgentChat = Workbench & { readonly definitionId: string };

/** A group workbench never carries a `definitionId`; every agent DM does. */
function isAgentChat(chat: Workbench): chat is AgentChat {
  return chat.definitionId !== null && chat.definitionId !== undefined;
}

function activityOf(chat: Workbench): number {
  return chat.lastActivityAt ? Date.parse(chat.lastActivityAt) : 0;
}

/**
 * Drop agent-DM chats minted against a superseded sibling definition of
 * the same agent (CL-6271), keeping every chat that belongs to the
 * live one (CL-6459).
 *
 * Shadowing already picks a single nearest definition per name in
 * `listVisibleAgentDefinitions`, but a DM chat is minted against a
 * specific definition id, so a caller who has separately DM'd the same
 * named agent (e.g. "Myra") launched from more than one ancestor tenant
 * ends up with one durable `Workbench` row per instance — the dedupe
 * there never runs again once a chat exists.
 *
 * `definitionId` is the discriminator that separates those stale
 * cross-tenant siblings from workbenches a person deliberately created:
 * "+ New Workbench" always mints against the bench's own currently
 * resolved definition (`instant-agent-create.ts`), so N deliberate
 * creations share one definition id and each keeps its row, while an
 * ancestor tenant's leftover DM carries a different one. Per agent
 * identity, the most recently active chat names the live definition;
 * chats under any other definition are the stale siblings.
 */
function dropSupersededAgentChats(chats: readonly Workbench[]): Workbench[] {
  const groupChats = chats.filter((chat) => !isAgentChat(chat));
  const agentChats = chats.filter(isAgentChat);

  const liveDefinitionByIdentity = new Map<string, AgentChat>();
  for (const chat of agentChats) {
    const key = agentIdentityKey(chat);
    const current = liveDefinitionByIdentity.get(key);
    if (current === undefined || activityOf(chat) > activityOf(current)) {
      liveDefinitionByIdentity.set(key, chat);
    }
  }

  return [
    ...groupChats,
    ...agentChats.filter(
      (chat) =>
        chat.definitionId ===
        liveDefinitionByIdentity.get(agentIdentityKey(chat))?.definitionId,
    ),
  ];
}

function recencyOf(row: SidebarRow): number {
  return activityOf(row.workbench);
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
  const dedupedChats = dropSupersededAgentChats(chats);
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
