// The sidebar's ONE recency-sorted stream (CL-6253): agent-DM rows sit
// alongside bench (workbench/chat) rows rather than in a section of their
// own. An agent already has a DM workbench the moment someone has opened
// it once — that workbench is just another `Workbench` row, already handled
// by `workbench-list.tsx`'s existing machinery. This module only decides
// which VISIBLE agent definitions still need a synthetic row (never
// opened, so no workbench exists yet) and how those synthetic rows sort
// and render alongside the real ones.

import type { Workbench, VisibleAgentDefinition } from "@corbits/chat-ui";

export type SidebarRow =
  | { readonly kind: "workbench"; readonly workbench: Workbench }
  | { readonly kind: "agent"; readonly agent: VisibleAgentDefinition };

/**
 * Every visible agent definition that has never been opened as a DM —
 * its id doesn't match any existing chat's `definitionId`. An agent
 * that HAS a DM already is represented by that chat's own `Workbench` row
 * (with its own preview/recency), never duplicated as a synthetic row
 * too.
 */
export function unopenedAgentRows(
  chats: readonly Workbench[],
  agents: readonly VisibleAgentDefinition[],
): readonly SidebarRow[] {
  const openedDefinitionIds = new Set(
    chats
      .map((chat) => chat.definitionId)
      .filter((id): id is string => id !== null && id !== undefined),
  );
  return agents
    .filter((agent) => !openedDefinitionIds.has(agent.id))
    .map((agent) => ({ kind: "agent", agent }) as const);
}

/** A row's own recency signal: a workbench's `lastActivityAt` (0 when
 * absent, sorting it last within its half), or an unopened agent's
 * `createdAt` — never a fabricated "just now". */
function recencyOf(row: SidebarRow): number {
  if (row.kind === "workbench") {
    return row.workbench.lastActivityAt
      ? Date.parse(row.workbench.lastActivityAt)
      : 0;
  }
  return Date.parse(row.agent.createdAt);
}

function isPinned(row: SidebarRow): boolean {
  return row.kind === "workbench" && row.workbench.pinned;
}

/**
 * Every bench (workbench + chat) row plus every never-opened agent row,
 * pinned first, then most-recent first within each half — the same
 * ordering rule `orderWorkbenchRows` applies to workbenches alone, widened
 * to the union. Stable within ties (agents with no activity at all sort
 * by their own insertion order, mirroring `orderWorkbenchRows`).
 */
export function buildSidebarRows(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
  agents: readonly VisibleAgentDefinition[],
): readonly SidebarRow[] {
  const rows: SidebarRow[] = [
    ...workbenches.map(
      (workbench) => ({ kind: "workbench", workbench }) as const,
    ),
    ...chats.map((workbench) => ({ kind: "workbench", workbench }) as const),
    ...unopenedAgentRows(chats, agents),
  ];
  const byRecency = (a: SidebarRow, b: SidebarRow) =>
    recencyOf(b) - recencyOf(a);
  return [
    ...rows.filter(isPinned).sort(byRecency),
    ...rows.filter((row) => !isPinned(row)).sort(byRecency),
  ];
}

const IDENTITY_COLOR_COUNT = 5;

/**
 * A deterministic CSS class off an agent's own display name — the same
 * agent always gets the same color everywhere it renders, with no
 * per-agent state to store. A plain string hash (not cryptographic:
 * this only needs a stable bucket, not collision resistance).
 */
export function identityColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const bucket = Math.abs(hash) % IDENTITY_COLOR_COUNT;
  return `shell-agent-color-${bucket}`;
}
