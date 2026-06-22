/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, it, expect, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkflowPanelProps } from '@workbench/ui';
import type { RunState, StepState } from '@intx/workflow';
import * as workflowHooks from '../hooks/use-workflow';

function CustomPanel({ deploymentId, stepOutputs, onSignal }: WorkflowPanelProps) {
  return (
    <div>
      <span>custom-panel-for-{deploymentId}</span>
      {Object.entries(stepOutputs).map(([stepId, output]) => (
        <span key={stepId}>
          out-{stepId}:{JSON.stringify(output)}
        </span>
      ))}
      <button onClick={() => onSignal('approve')}>fire-signal</button>
    </div>
  );
}

mock.module('../lib/workflow-ui', () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === 'with-panel') return { Panel: CustomPanel };
    return {};
  },
}));

function step(stepId: string, phase: StepState['phase'] = 'completed'): StepState {
  return {
    stepId,
    phase,
    outputRef: phase === 'completed' ? `inline:${stepId}` : undefined,
    currentAttempt: 1,
  } as unknown as StepState;
}

function mixedRunState(phase: RunState['phase'] = 'running'): RunState {
  return {
    runId: 'run-mixed',
    phase,
    lastSeq: 5,
    steps: new Map([
      ['step-ok', step('step-ok')],
      ['step-bad', step('step-bad')],
      [
        'step-pending',
        {
          stepId: 'step-pending',
          phase: 'in-flight',
          currentAttempt: 1,
        } as unknown as StepState,
      ],
    ]),
  } as RunState;
}

let runState: RunState | null = null;
let settled = true;

// All-step-outputs mock: returns a map for dep-mixed, empty for others.
const allStepOutputsMock = mock((deploymentId: string | null) => {
  if (deploymentId === 'dep-mixed') {
    return {
      data: { 'step-ok': { headline: 'hi' } },
      isSuccess: true,
    };
  }
  return { data: {}, isSuccess: true };
});

// Track signal calls to assert terminal gating.
const signalMutateAsync = mock(async () => undefined);

// Spread the real module so untouched exports keep their real implementations.
mock.module('../hooks/use-workflow', () => ({
  ...workflowHooks,
  useMyRuns: () => ({ data: [], isPending: false }),
  useWorkflowRuns: () => ({
    data: [
      { deploymentId: 'dep-panel', kind: 'with-panel', status: 'active', createdAt: '' },
      { deploymentId: 'dep-plain', kind: 'no-panel', status: 'active', createdAt: '' },
      { deploymentId: 'dep-mixed', kind: 'with-panel', status: 'active', createdAt: '' },
    ],
    isPending: false,
  }),
  useWorkflowRunState: () => ({ state: runState, events: [], connected: true, settled }),
  useSignalWorkflow: () => ({
    mutateAsync: signalMutateAsync,
    isPending: false,
  }),
  useAllStepOutputs: (deploymentId: string | null) => allStepOutputsMock(deploymentId),
  useSetRunStatus: () => ({ mutate: () => undefined }),
  isTerminalPhase: workflowHooks.isTerminalPhase,
}));

import { WorkflowRunPane } from './WorkflowRunPane';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('WorkflowRunPane', () => {
  afterEach(() => {
    cleanup();
    runState = null;
    settled = true;
    signalMutateAsync.mockClear();
    allStepOutputsMock.mockClear();
  });

  it('renders the workflow kind own Panel when its module exports one', async () => {
    render(<WorkflowRunPane deploymentId="dep-panel" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('custom-panel-for-dep-panel'));
  });

  it('falls back to RunConsole when the module has no Panel', async () => {
    render(<WorkflowRunPane deploymentId="dep-plain" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('Workflow run'));
    expect(screen.queryByText('custom-panel-for-dep-plain')).toBeNull();
  });

  it('shows loading placeholder before settled, not the panel content', async () => {
    settled = false;
    runState = null;
    render(<WorkflowRunPane deploymentId="dep-panel" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('Loading run…'));
    expect(screen.queryByText('custom-panel-for-dep-panel')).toBeNull();
  });

  it('renders empty deploymentId as a loading placeholder without firing hooks', () => {
    render(<WorkflowRunPane deploymentId="" onClose={() => undefined} />, { wrapper });
    screen.getByText('Loading…');
    expect(signalMutateAsync).not.toHaveBeenCalled();
  });

  it('passes step outputs from useAllStepOutputs to the Panel', async () => {
    runState = mixedRunState();
    render(<WorkflowRunPane deploymentId="dep-mixed" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('out-step-ok:{"headline":"hi"}'));
  });

  it('onSignal fires when the run is active', async () => {
    runState = mixedRunState('running');
    render(<WorkflowRunPane deploymentId="dep-mixed" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('fire-signal'));
    screen.getByText('fire-signal').click();
    await waitFor(() => expect(signalMutateAsync).toHaveBeenCalledTimes(1));
  });

  it('onSignal is a no-op when the run is in a terminal phase', async () => {
    runState = mixedRunState('completed');
    render(<WorkflowRunPane deploymentId="dep-mixed" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('fire-signal'));
    screen.getByText('fire-signal').click();
    expect(signalMutateAsync).not.toHaveBeenCalled();
  });
});
