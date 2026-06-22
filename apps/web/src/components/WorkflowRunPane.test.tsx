/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, it, expect, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkflowPanelProps } from '@workbench/ui';
import * as workflowHooks from '../hooks/use-workflow';
import type { RunRecord } from '../lib/run-state-adapter';

function CustomPanel({ deploymentId, stepOutputs, onSignal }: WorkflowPanelProps) {
  return (
    <div>
      <span>custom-panel-for-{deploymentId}</span>
      {Object.entries(stepOutputs).map(([stepId, output]) => (
        <span key={stepId}>
          out-{stepId}:{JSON.stringify(output)}
        </span>
      ))}
      <button onClick={() => onSignal('approve', { ok: true })}>fire-signal</button>
    </div>
  );
}

mock.module('../lib/workflow-ui', () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === 'with-panel') return { Panel: CustomPanel };
    return {};
  },
}));

// Record served by the mocked record hook, swapped per test.
let record: RunRecord | null = null;
let isLoading = false;
let isError = false;

const resumeMutateAsync = mock(async () => undefined);

mock.module('../hooks/use-workflow', () => ({
  ...workflowHooks,
  useWorkflowRecord: () => ({ data: record ?? undefined, isLoading, isError }),
  useResumeWorkflow: () => ({ mutateAsync: resumeMutateAsync, isPending: false }),
}));

import { WorkflowRunPane } from './WorkflowRunPane';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeRecord(over: Partial<RunRecord>): RunRecord {
  return {
    runId: 'wfr_1',
    kind: 'with-panel',
    status: 'awaiting',
    currentStepId: 'gate',
    outputs: {},
    ...over,
  };
}

describe('WorkflowRunPane', () => {
  afterEach(() => {
    cleanup();
    record = null;
    isLoading = false;
    isError = false;
    resumeMutateAsync.mockClear();
  });

  it('renders the workflow kind own Panel when its module exports one', async () => {
    record = makeRecord({});
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('custom-panel-for-wfr_1'));
  });

  it('falls back to RunConsole when the module has no Panel', async () => {
    record = makeRecord({ kind: 'no-panel' });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('Workflow run'));
    expect(screen.queryByText('custom-panel-for-wfr_1')).toBeNull();
  });

  it('shows the loading placeholder while the record query is loading', () => {
    isLoading = true;
    record = null;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    screen.getByText('Loading run…');
    expect(screen.queryByText('custom-panel-for-wfr_1')).toBeNull();
  });

  it('shows an error message when the record query errors', () => {
    isError = true;
    record = null;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    screen.getByText(/couldn't load this workflow run/i);
  });

  it('renders empty deploymentId as a loading placeholder without firing resume', () => {
    render(<WorkflowRunPane deploymentId="" onClose={() => undefined} />, { wrapper });
    screen.getByText('Loading…');
    expect(resumeMutateAsync).not.toHaveBeenCalled();
  });

  it('hands the record outputs map straight to the Panel as stepOutputs', async () => {
    record = makeRecord({ outputs: { 'step-ok': { headline: 'hi' } } });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('out-step-ok:{"headline":"hi"}'));
  });

  it('onSignal resumes when the run is awaiting', async () => {
    record = makeRecord({ status: 'awaiting' });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('fire-signal'));
    screen.getByText('fire-signal').click();
    await waitFor(() => expect(resumeMutateAsync).toHaveBeenCalledTimes(1));
    expect(resumeMutateAsync).toHaveBeenCalledWith({
      signalName: 'approve',
      payload: { ok: true },
    });
  });

  it('onSignal is a no-op once the run is terminal', async () => {
    record = makeRecord({ status: 'completed', currentStepId: null, outputs: { persist: {} } });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('fire-signal'));
    screen.getByText('fire-signal').click();
    expect(resumeMutateAsync).not.toHaveBeenCalled();
  });
});
