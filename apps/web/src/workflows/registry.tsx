import type { ComponentType } from 'react';
import { WorkflowPanel } from '../components/WorkflowPanel';
import { NewWorkflowPane } from '../components/NewWorkflowPane';
import { PresentationNewPane } from './presentation/PresentationNewPane';
import { PresentationSelectedPanel } from './presentation/PresentationSelectedPanel';

export interface AgentSelectionTarget {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

export interface WorkflowNewPaneProps {
  workflowKind: string;
  tenantId: string | null;
  onCreated: (workflowId: string) => void;
  onClose: () => void;
  /** Preselect an existing artifact as the workflow source (e.g. "Use in Workflow").
   *  The pane loads the artifact by id; not every workflow supports seeding. */
  seedArtifactId?: string;
}

export interface WorkflowSelectedPanelProps {
  workflowId: string;
  onClose: () => void;
  onOpenAgent: (selection: AgentSelectionTarget) => void;
}

export interface WorkflowUiEntry {
  NewPane: ComponentType<WorkflowNewPaneProps>;
  SelectedPanel: ComponentType<WorkflowSelectedPanelProps>;
}

function CollateralSelectedPanel({ workflowId, onClose }: WorkflowSelectedPanelProps) {
  return <WorkflowPanel workflowId={workflowId} onClose={onClose} />;
}

// Each workflow kind registers its own UI here. Adding a new workflow means
// adding an entry (and its components) — no branching anywhere in the page.
const WORKFLOW_UI: Record<string, WorkflowUiEntry> = {
  'collateral-generation': {
    NewPane: NewWorkflowPane,
    SelectedPanel: CollateralSelectedPanel,
  },
  'presentation-generation': {
    NewPane: PresentationNewPane,
    SelectedPanel: PresentationSelectedPanel,
  },
};

export function getWorkflowUi(kind: string): WorkflowUiEntry {
  const entry = WORKFLOW_UI[kind];
  if (!entry) {
    throw new Error(`No workflow UI registered for kind: ${kind}`);
  }
  return entry;
}
