import { useState } from "react";

export type RightPane =
  | { view: "gallery" }
  | { view: "agent"; instanceId: string; tenantId: string; agentName: string }
  | { view: "workflow"; deploymentId: string };

export interface AgentTarget {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

// Owns the right-pane routing state and every transition between panes. The
// page passes onShow/onClose so it can keep side effects (e.g. hiding the chat
// launcher) at the page level while the transition logic lives here.
export function useRightPane(options: {
  onShow?: () => void;
  onClose?: () => void;
}) {
  const { onShow, onClose } = options;
  const [rightPane, setRightPane] = useState<RightPane>({ view: "gallery" });

  const showGallery = () => {
    setRightPane({ view: "gallery" });
    onClose?.();
  };

  const showAgent = (target: AgentTarget) => {
    setRightPane({ view: "agent", ...target });
    onShow?.();
  };

  const showWorkflow = (deploymentId: string) => {
    setRightPane({ view: "workflow", deploymentId });
    onShow?.();
  };

  const closeWorkflow = (deploymentId: string) => {
    if (
      rightPane.view === "workflow" &&
      rightPane.deploymentId === deploymentId
    ) {
      showGallery();
    }
  };

  return {
    rightPane,
    showGallery,
    showAgent,
    showWorkflow,
    closeWorkflow,
  };
}
