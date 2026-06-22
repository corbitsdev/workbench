import type { RunState } from '@intx/workflow';

export interface WorkflowCredential {
  id: string;
  name: string;
  providerName: string;
  providerPlugin: string;
  model?: string;
}

export interface WorkflowSkill {
  id: string;
  name: string;
  displayName: string | null;
}

export interface WorkflowPanelProps {
  deploymentId: string;
  state: RunState | null;
  connected: boolean;
  /**
   * Resolved outputs for completed steps, keyed by stepId. The host
   * (WorkflowRunPane) fetches these from the step-output endpoint so panels
   * stay pure, client-safe presentational components — no data fetching, no
   * dependency on apps/web. A stepId is absent until its step completes and
   * its output resolves.
   */
  stepOutputs: Record<string, unknown>;
  /**
   * True while a signal posted via `onSignal` is in flight. The host gates
   * concurrent signals and exposes this so panels disable their
   * continue/inference buttons immediately on click, preventing a double-fire
   * before the server advances the run `phase`.
   */
  signalPending: boolean;
  onSignal: (signalName: string, payload?: unknown) => void;
  onClose: () => void;
  /** Inference credentials passed from the host for config-step pickers. */
  credentials?: WorkflowCredential[];
  /** Visible skills from the workspace library for workflow-specific selectors. */
  skills?: WorkflowSkill[];
}
