/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { LibraryRailProps } from './LibraryRail';
import type { RunInstanceSummary } from '@workbench/client/react';

const fakeRun: RunInstanceSummary = {
  runId: 'run-1',
  correlationMessageId: 'msg-1',
  deploymentId: 'dep-1',
  kind: 'collateral-generation',
  status: 'running',
  startedAt: new Date().toISOString(),
};

const mockDeleteRunMutateAsync = mock((_runId: string) => Promise.resolve());

mock.module('../../hooks/use-workflow', () => ({
  useDeleteRun: () => ({
    mutateAsync: mockDeleteRunMutateAsync,
  }),
}));

// myRunsOverride lets individual tests substitute a different run list without
// re-mocking the entire module.
let myRunsOverride: RunInstanceSummary[] | null = null;

mock.module('@workbench/client/react', () => ({
  useMyRuns: () => ({
    data: myRunsOverride ?? [fakeRun],
    isLoading: false,
    isError: false,
  }),
  useArtifacts: () => ({ data: [], isLoading: false, isError: false }),
}));

mock.module('../../lib/hub-api', () => ({
  getMe: mock(() =>
    Promise.resolve({
      userId: '',
      userName: '',
      orgName: '',
      personalTenantId: null,
      paInstanceId: null,
      provisioned: false,
      credentialResolved: false,
    })
  ),
  getMyPrincipals: mock(() => Promise.resolve([])),
  listWorkbenches: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  launchInstanceSession: mock(() => Promise.resolve({ launched: true })),
  deleteAgentInstance: mock(() => Promise.resolve()),
  stopAgentInstance: mock(() => Promise.resolve()),
}));

// Controllable transport so the activity hook subscribes without a real
// EventSource (absent in happy-dom). Tests push events through `emitEvent`.
const eventListeners = new Map<string, Set<(event: unknown) => void>>();
function emitEvent(instanceId: string, tenantId: string, event: unknown): void {
  const path = `/api/tenants/${tenantId}/agents/instances/${instanceId}/events`;
  const listeners = eventListeners.get(path);
  if (listeners) for (const listener of listeners) listener(event);
}
mock.module('../../lib/instance-transport', () => ({
  createHubTransport: () => ({
    fetch: async () => undefined,
    subscribe(path: string, onEvent: (event: unknown) => void) {
      const listeners = eventListeners.get(path) ?? new Set();
      listeners.add(onEvent);
      eventListeners.set(path, listeners);
      return () => {
        listeners.delete(onEvent);
        if (listeners.size === 0) eventListeners.delete(path);
      };
    },
  }),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

afterEach(() => {
  cleanup();
  myRunsOverride = null;
});

describe('LibraryRail', () => {
  it('renders one row per run from useMyRuns, labelled by kind', async () => {
    myRunsOverride = [
      fakeRun,
      {
        runId: 'run-2',
        correlationMessageId: 'msg-2',
        deploymentId: 'dep-2',
        kind: 'presentation-generation',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    ];

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      // Title shows the workflow type label resolved from the run kind.
      expect(view.getAllByText('Collateral Generation').length).toBeGreaterThan(0);
    });
    expect(view.getAllByText('Presentation Generation').length).toBeGreaterThan(0);
    expect(view.getAllByText('Workflows').length).toBeGreaterThan(0);
  });

  it('renders the + button when onNew is provided and workbenches are present', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'wb-1',
          tenantId: 'tn-1',
          tenantSlug: 'acme',
          tenantName: 'Acme',
        },
      ])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));

    const { LibraryRail } = await import('./LibraryRail');
    const props: LibraryRailProps = { onNew: () => void 0 };
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, props)
    );

    await waitFor(() => {
      view.getByRole('button', { name: 'Add agent' });
    });
  });

  it('does not render the + button when onNew is not provided', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(view.queryByRole('button', { name: 'Add agent' })).toBeNull();
    });
  });

  it('opens deployed agents so the chat can launch or show the real error', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'wb-1',
          tenantId: 'tn-1',
          tenantSlug: 'acme',
          tenantName: 'Acme',
        },
      ])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'inst-1',
          agentId: 'ag-1',
          agentName: 'Loop',
          tenantId: 'tn-1',
          address: '',
          status: 'deployed',
          credentialRequirements: [],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    const onAgentSelect = mock(() => undefined);

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, {
        activeWorkbenchSlug: 'acme',
        onAgentSelect,
      })
    );

    await waitFor(() => {
      view.getByText('Loop');
    });

    fireEvent.click(view.getByRole('button', { name: 'Open agent Loop' }));

    expect(onAgentSelect).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      tenantId: 'tn-1',
      agentName: 'Loop',
    });
  });

  it('calls onWorkflowSelect with runId, deploymentId, and kind when a workflow row is clicked', async () => {
    const { listWorkbenches } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));
    const onWorkflowSelect = mock(
      (_runId: string | null, _deploymentId: string, _kind: string) => undefined
    );

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, {
        onWorkflowSelect,
      })
    );

    const row = await waitFor(() =>
      view.getByRole('button', { name: 'Open workflow Collateral Generation' })
    );
    fireEvent.click(row);

    expect(onWorkflowSelect).toHaveBeenCalledWith('run-1', 'dep-1', 'collateral-generation');
  });

  it('activates a workflow row via the keyboard as a native button', async () => {
    const { listWorkbenches } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));
    const onWorkflowSelect = mock(
      (_runId: string | null, _deploymentId: string, _kind: string) => undefined
    );
    const user = userEvent.setup();

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, {
        onWorkflowSelect,
      })
    );

    const row = await waitFor(() =>
      view.getByRole('button', { name: 'Open workflow Collateral Generation' })
    );
    row.focus();
    await user.keyboard('{Enter}');

    expect(onWorkflowSelect).toHaveBeenCalledWith('run-1', 'dep-1', 'collateral-generation');
  });

  it('keeps loaded agents visible and warns when one workbench fails to load agents', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'wb-1',
          tenantId: 'tn-ok',
          tenantSlug: 'acme',
          tenantName: 'Acme',
        },
        {
          id: 'wb-2',
          tenantId: 'tn-fail',
          tenantSlug: 'beta',
          tenantName: 'Beta',
        },
      ])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation((tenantId: string) => {
      if (tenantId === 'tn-fail') return Promise.reject(new Error('forbidden'));
      return Promise.resolve([
        {
          id: 'inst-1',
          agentId: 'ag-1',
          agentName: 'Loop',
          tenantId,
          address: '',
          status: 'running',
          credentialRequirements: [],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    });

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      view.getByText('Loop');
    });

    view.getByText('Some agents could not be loaded.');
  });

  it('reflects a running agent live activity phase in the sidebar', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'wb-1',
          tenantId: 'tn-ok',
          tenantSlug: 'acme',
          tenantName: 'Acme',
        },
      ])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation((tenantId: string) =>
      Promise.resolve([
        {
          id: 'inst-9',
          agentId: 'ag-9',
          agentName: 'Loop',
          tenantId,
          address: '',
          status: 'running',
          credentialRequirements: [],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ])
    );

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    // A running agent with no live stream reads as idle.
    await waitFor(() => {
      expect(view.getByText('Agent · Idle')).not.toBeNull();
    });

    act(() => {
      emitEvent('inst-9', 'tn-ok', {
        type: 'inference.thinking.delta',
        data: { partial: { thinking: 'considering' } },
      });
    });
    await waitFor(() => {
      expect(view.getByText('Agent · Reasoning')).not.toBeNull();
    });
  });

  it('places a completed-status workflow in the Done section with a Completed badge', async () => {
    myRunsOverride = [
      {
        runId: 'run-done',
        correlationMessageId: 'msg-done',
        deploymentId: 'dep-done',
        kind: 'collateral-generation',
        status: 'completed',
        startedAt: new Date().toISOString(),
      },
    ];

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    // The Done section toggle should be visible and labelled "Completed".
    const doneToggle = await waitFor(() => view.getByText('Completed'));
    fireEvent.click(doneToggle);

    // After expansion, a Completed badge appears inside the row.
    await waitFor(() => {
      const badges = view.getAllByText('Completed');
      expect(badges.length).toBeGreaterThan(1);
    });
  });

  it('deletes the RUN (not the deployment) by runId when Remove is confirmed', async () => {
    myRunsOverride = [
      {
        runId: 'run-remove-me',
        correlationMessageId: 'msg-remove-me',
        deploymentId: 'dep-keep-me',
        kind: 'collateral-generation',
        status: 'completed',
        startedAt: new Date().toISOString(),
      },
    ];
    mockDeleteRunMutateAsync.mockReset();
    mockDeleteRunMutateAsync.mockImplementation(() => Promise.resolve());

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    // Open the Done section.
    const doneToggle = await waitFor(() => view.getByText('Completed'));
    fireEvent.click(doneToggle);

    // Click Remove to enter the confirm state.
    const removeBtn = await waitFor(() =>
      view.getByRole('button', { name: 'Remove workflow Collateral Generation' })
    );
    fireEvent.click(removeBtn);

    // Click Confirm.
    const confirmBtn = await waitFor(() =>
      view.getByRole('button', { name: 'Confirm remove workflow Collateral Generation' })
    );
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      // The run-scoped delete receives the runId, NOT the deploymentId.
      expect(mockDeleteRunMutateAsync).toHaveBeenCalledWith('run-remove-me');
    });
    expect(mockDeleteRunMutateAsync).not.toHaveBeenCalledWith('dep-keep-me');
  });

  it('hides the Remove affordance for a run whose runId is not yet reconciled', async () => {
    myRunsOverride = [
      {
        runId: null,
        correlationMessageId: 'msg-pending',
        deploymentId: 'dep-pending',
        kind: 'collateral-generation',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    ];

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => view.getByText('Collateral Generation'));
    expect(
      view.queryByRole('button', { name: 'Remove workflow Collateral Generation' })
    ).toBeNull();
  });
});

describe('CompletedWorkflowRow (pure view)', () => {
  const item = {
    id: 'wf-done',
    group: 'Workflows' as const,
    name: 'Collateral Generation',
    type: 'workflow' as const,
    sub: 'Acme Corp · Done',
    status: 'done' as const,
    who: 'GA',
    color: 'var(--accent)',
    workflowStatus: 'done',
    workflowKind: 'collateral-generation',
    runId: 'run-done',
    deploymentId: 'dep-done',
    correlationMessageId: 'msg-done',
  };

  it('invokes onOpen with no further data dependencies when the row is activated', async () => {
    const { CompletedWorkflowRow } = await import('./LibraryRail');
    const onOpen = mock(() => {});
    const view = render(
      React.createElement(CompletedWorkflowRow, {
        item,
        isActive: false,
        onOpen,
      })
    );
    fireEvent.click(view.getByRole('button', { name: 'Open workflow Collateral Generation' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders without an open affordance when onOpen is omitted', async () => {
    const { CompletedWorkflowRow } = await import('./LibraryRail');
    const view = render(
      React.createElement(CompletedWorkflowRow, {
        item,
        isActive: false,
      })
    );
    expect(
      view.queryByRole('button', {
        name: 'Open workflow Collateral Generation',
      })
    ).toBeNull();
    view.getByText('Collateral Generation');
  });
});
