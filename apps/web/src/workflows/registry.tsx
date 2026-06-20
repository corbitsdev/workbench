export interface AgentSelectionTarget {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

// The workflow UI is now generic: every kind starts via NewRunPane and is
// observed through the native RunConsole, so there is no per-kind registry.
// These props are retained for the page wiring that mounts the generic panes.
export interface WorkflowNewPaneProps {
  workflowKind: string;
  onStarted: (deploymentId: string) => void;
  onClose: () => void;
}

export interface WorkflowSelectedPanelProps {
  deploymentId: string;
  onClose: () => void;
}
