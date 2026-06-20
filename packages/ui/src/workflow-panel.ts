import type { RunState } from '@intx/workflow';

export interface WorkflowPanelProps {
  deploymentId: string;
  state: RunState | null;
  connected: boolean;
  onSignal: (signalName: string, payload?: unknown) => void;
  onClose: () => void;
}
