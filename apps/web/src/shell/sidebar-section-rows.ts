import type { VisibleAgentDefinition, Workbench } from "@corbits/chat-ui";

export type AgentSidebarRow =
  | { readonly kind: "persisted"; readonly workbench: Workbench }
  | {
      readonly kind: "definition";
      readonly definition: VisibleAgentDefinition;
    };

export type SidebarSections = {
  readonly agents: readonly AgentSidebarRow[];
  readonly channels: readonly Workbench[];
};

function activityOf(workbench: Workbench): number {
  return workbench.lastActivityAt ? Date.parse(workbench.lastActivityAt) : 0;
}

function orderPersistedRows(rows: readonly Workbench[]): readonly Workbench[] {
  const byRecency = (a: Workbench, b: Workbench) =>
    activityOf(b) - activityOf(a);
  return [
    ...rows.filter((row) => row.pinned).sort(byRecency),
    ...rows.filter((row) => !row.pinned).sort(byRecency),
  ];
}

function agentRecency(row: AgentSidebarRow): number {
  return row.kind === "persisted"
    ? activityOf(row.workbench)
    : Date.parse(row.definition.createdAt);
}

export function buildSidebarSections(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
  definitions: readonly VisibleAgentDefinition[],
): SidebarSections {
  const agentChats = chats.filter(
    (chat): chat is Workbench & { readonly definitionId: string } =>
      chat.definitionId !== undefined,
  );
  const openedDefinitionIds = new Set(
    agentChats.map((chat) => chat.definitionId),
  );
  const persistedAgents: AgentSidebarRow[] = orderPersistedRows(agentChats).map(
    (workbench) => ({ kind: "persisted", workbench }),
  );
  const unopenedAgents: AgentSidebarRow[] = definitions
    .filter((definition) => !openedDefinitionIds.has(definition.id))
    .map((definition) => ({ kind: "definition", definition }));
  const pinnedAgents = persistedAgents.filter(
    (row) => row.kind === "persisted" && row.workbench.pinned,
  );
  const unpinnedAgents = [...persistedAgents, ...unopenedAgents]
    .filter((row) => row.kind === "definition" || !row.workbench.pinned)
    .sort((a, b) => agentRecency(b) - agentRecency(a));

  return {
    agents: [...pinnedAgents, ...unpinnedAgents],
    channels: orderPersistedRows(workbenches),
  };
}
