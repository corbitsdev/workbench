import { useState } from 'react';

export type RightPane =
  | { view: 'gallery' }
  | { view: 'agent'; instanceId: string; tenantId: string; agentName: string }
  | { view: 'workflow'; deploymentId: string }
  | { view: 'new-workflow'; workflowKind: string };

export interface AgentTarget {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

// Owns the right-pane routing state and every transition between panes. The
// page passes onShow/onClose so it can keep side effects (e.g. hiding the chat
// launcher) at the page level while the transition logic lives here.
export function useRightPane(options: { onShow?: () => void; onClose?: () => void }) {
  const { onShow, onClose } = options;
  const [rightPane, setRightPane] = useState<RightPane>({ view: 'gallery' });

  const showGallery = () => {
    setRightPane({ view: 'gallery' });
    onClose?.();
  };

  const showAgent = (target: AgentTarget) => {
    setRightPane({ view: 'agent', ...target });
    onShow?.();
  };

  const showWorkflow = (deploymentId: string) => {
    setRightPane({ view: 'workflow', deploymentId });
    onShow?.();
  };

  const showNewWorkflow = (workflowKind: string) => {
    setRightPane({ view: 'new-workflow', workflowKind });
    onShow?.();
  };

  // Promote a freshly started run from the new-workflow pane into the live run
  // console; ignored if the new-workflow pane is no longer active.
  const promoteCreatedWorkflow = (deploymentId: string) => {
    if (rightPane.view !== 'new-workflow') return;
    setRightPane({ view: 'workflow', deploymentId });
  };

  const closeWorkflow = (deploymentId: string) => {
    if (rightPane.view === 'workflow' && rightPane.deploymentId === deploymentId) {
      showGallery();
    }
  };

  return {
    rightPane,
    showGallery,
    showAgent,
    showWorkflow,
    showNewWorkflow,
    promoteCreatedWorkflow,
    closeWorkflow,
  };
}
