/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUpdateStepConfig = mock(() => ({
  mutate: mock((_config: unknown, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  }),
  isPending: false,
  isError: false,
  error: null,
}));

const mockWorkbenchAgents = mock(() => ({
  data: [
    {
      id: 'inst-1',
      agentId: 'agent-1',
      agentName: 'Myra',
      tenantId: 't-1',
      address: 'inst-1@t-1.example.com',
      status: 'running',
      credentialRequirements: [],
      capabilities: { tools: ['web_search', 'code_runner'] },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'inst-2',
      agentId: 'agent-2',
      agentName: 'Oat',
      tenantId: 't-1',
      address: 'inst-2@t-1.example.com',
      status: 'running',
      credentialRequirements: [],
      capabilities: null,
      createdAt: new Date().toISOString(),
    },
  ],
  isLoading: false,
}));

mock.module('../hooks/use-workflow', () => ({
  useUpdateStepConfig: mockUpdateStepConfig,
  useWorkbenchAgents: mockWorkbenchAgents,
}));

import { WorkflowStepConfig } from './WorkflowStepConfig';

function renderConfig(workflowId = 'wf-1', currentConfig: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WorkflowStepConfig, {
        workflowId,
        currentConfig,
      })
    )
  );
}

describe('WorkflowStepConfig', () => {
  beforeEach(() => {
    mockUpdateStepConfig.mockReset();
    mockUpdateStepConfig.mockImplementation(() => ({
      mutate: mock((_config: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      }),
      isPending: false,
      isError: false,
      error: null,
    }));
  });

  afterEach(cleanup);

  it('renders a section label and rows for each configurable step', () => {
    renderConfig();
    expect(screen.getByText('Step configuration')).toBeTruthy();
    expect(screen.getByText('Analyze')).toBeTruthy();
    expect(screen.getByText('Generate')).toBeTruthy();
    expect(screen.getByText('Improve')).toBeTruthy();
  });

  it('renders agent dropdowns with Default option and available agents', () => {
    renderConfig();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(3); // one per step
    // Each should have "Default" option
    selects.forEach((sel) => {
      expect(sel.querySelector('option[value=""]')?.textContent).toBe('Default');
    });
    // Available agents listed
    const myraOptions = screen.getAllByText('Myra');
    expect(myraOptions.length).toBe(3);
  });

  it('shows pre-existing agent selection from currentConfig', () => {
    renderConfig('wf-1', { analyze: { agentId: 'inst-1', toolIds: [] } });
    const selects = screen.getAllByRole('combobox');
    const analyzeSelect = selects[0]!;
    expect((analyzeSelect as HTMLSelectElement).value).toBe('inst-1');
  });

  it('renders tool toggles when an agent with tools is selected', async () => {
    renderConfig('wf-1', { analyze: { agentId: 'inst-1', toolIds: [] } });
    expect(screen.getByText('web_search')).toBeTruthy();
    expect(screen.getByText('code_runner')).toBeTruthy();
  });

  it('does not show tools section when agent has no capabilities', async () => {
    renderConfig('wf-1', { generate: { agentId: 'inst-2', toolIds: [] } });
    // Oat has null capabilities — no tool buttons should appear
    expect(screen.queryByText('web_search')).toBeNull();
  });

  it('Save button is disabled when config has not changed', () => {
    renderConfig('wf-1', {});
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('Save button becomes enabled after a change', async () => {
    const user = userEvent.setup();
    renderConfig('wf-1', {});
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0]!, 'inst-1');
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls updateStepConfig with correct payload on save', async () => {
    const mutateMock = mock((_config: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    mockUpdateStepConfig.mockImplementation(() => ({
      mutate: mutateMock,
      isPending: false,
      isError: false,
      error: null,
    }));

    const user = userEvent.setup();
    renderConfig('wf-1', {});
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0]!, 'inst-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutateMock.mock.calls.length).toBe(1);
    const savedConfig = mutateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((savedConfig as { analyze?: { agentId?: string } }).analyze?.agentId).toBe('inst-1');
  });
});
