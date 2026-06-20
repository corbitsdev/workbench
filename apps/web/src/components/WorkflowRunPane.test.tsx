/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, it, expect, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkflowPanelProps } from '@workbench/ui';

function CustomPanel({ deploymentId }: WorkflowPanelProps) {
  return <div>custom-panel-for-{deploymentId}</div>;
}

mock.module('../lib/workflow-ui', () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === 'with-panel') return { Panel: CustomPanel };
    return {};
  },
}));

mock.module('../hooks/use-workflow', () => ({
  useWorkflowRuns: () => ({
    data: [
      { deploymentId: 'dep-panel', kind: 'with-panel', status: 'active', createdAt: '' },
      { deploymentId: 'dep-plain', kind: 'no-panel', status: 'active', createdAt: '' },
    ],
    isPending: false,
  }),
  useWorkflowRunState: () => ({ state: null, events: [], connected: true }),
  useSignalWorkflow: () => ({ mutateAsync: async () => undefined, isPending: false }),
}));

import { WorkflowRunPane } from './WorkflowRunPane';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('WorkflowRunPane', () => {
  afterEach(cleanup);

  it('renders the workflow kind own Panel when its module exports one', async () => {
    render(<WorkflowRunPane deploymentId="dep-panel" onClose={() => undefined} />, { wrapper });
    await waitFor(() => screen.getByText('custom-panel-for-dep-panel'));
  });

  it('falls back to RunConsole when the module has no Panel', async () => {
    render(<WorkflowRunPane deploymentId="dep-plain" onClose={() => undefined} />, { wrapper });
    // RunConsole renders the generic run header; the custom panel must not appear.
    await waitFor(() => screen.getByText('Workflow run'));
    expect(screen.queryByText('custom-panel-for-dep-plain')).toBeNull();
  });
});
