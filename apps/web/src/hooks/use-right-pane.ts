import { useState } from 'react';

export type RightPane =
  | { view: 'gallery' }
  | { view: 'agent'; instanceId: string; tenantId: string; agentName: string }
  | { view: 'workflow'; workflowId: string }
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

  const showWorkflow = (workflowId: string) => {
    setRightPane({ view: 'workflow', workflowId });
    onShow?.();
  };

  const showNewWorkflow = (workflowKind: string) => {
    setRightPane({ view: 'new-workflow', workflowKind });
    onShow?.();
  };

  // Promote a freshly created workflow from the new-workflow wizard into the
  // live workflow panel; ignored if the wizard is no longer the active pane.
  const promoteCreatedWorkflow = (workflowId: string) => {
    if (rightPane.view !== 'new-workflow') return;
    setRightPane({ view: 'workflow', workflowId });
  };

  const closeWorkflow = (workflowId: string) => {
    if (rightPane.view === 'workflow' && rightPane.workflowId === workflowId) {
      showGallery();
    }
  };

  const isPresentationWizardOpen =
    rightPane.view === 'new-workflow' && rightPane.workflowKind === 'presentation-generation';

  return {
    rightPane,
    showGallery,
    showAgent,
    showWorkflow,
    showNewWorkflow,
    promoteCreatedWorkflow,
    closeWorkflow,
    isPresentationWizardOpen,
  };
}
