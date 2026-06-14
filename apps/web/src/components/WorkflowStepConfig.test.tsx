/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Drive the real useWorkbenchAgents + useUpdateStepConfig through the fetch
// boundary instead of module-mocking ../hooks/use-workflow, whose process-wide
// leak under bun replaced the real hooks in use-workflow.test.
const originalFetch = globalThis.fetch;

const agents = [
  {
    id: 'inst-1',
    agentId: 'agent-1',
    agentName: 'Myra',
    tenantId: 't-1',
    address: 'inst-1@t-1.example.com',
    status: 'running',
    credentialRequirements: [],
    capabilities: { tools: ['web_search', 'code_runner'] },
    createdAt: '2026-01-01T00:00:00.000Z',
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
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

let stepConfigPatches: unknown[] = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// useWorkbenchAgents fans out: listWorkbenches (GET /me/principals + GET /api/v1/me)
// then listAgentInstances per workbench. Route those so the real hook returns the
// two agents above; capture the step-config PATCH body for assertions.
function routeFetch(url: string, init?: RequestInit): Response {
  if (url.includes('/me/principals')) {
    return jsonResponse({ data: [{ principalId: 'p1', tenantId: 't-1' }] });
  }
  if (url.includes('/api/v1/me')) {
    return jsonResponse({ rootTenantIds: [], personalTenantId: null });
  }
  if (url.includes('/agents?tenantId=')) {
    return jsonResponse({ data: agents });
  }
  if (url.includes('/step-config') && init?.method === 'PATCH') {
    stepConfigPatches.push(JSON.parse(String(init.body)));
    return jsonResponse({ id: 'wf-1', stepConfig: {} });
  }
  return jsonResponse({});
}

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  stepConfigPatches = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init))
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

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
  it('renders a section label and rows for each configurable step', () => {
    renderConfig();
    expect(screen.getByText('Step configuration')).toBeTruthy();
    expect(screen.getByText('Analyze')).toBeTruthy();
    expect(screen.getByText('Generate')).toBeTruthy();
  });

  it('renders agent dropdowns with Default option and available agents', async () => {
    renderConfig();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2); // one per step
    selects.forEach((sel) => {
      expect(sel.querySelector('option[value=""]')?.textContent).toBe('Default');
    });
    // Available agents are loaded asynchronously via the real hook.
    await waitFor(() => {
      expect(screen.getAllByText('Myra').length).toBe(2);
    });
  });

  it('shows pre-existing agent selection from currentConfig', async () => {
    renderConfig('wf-1', { analyze: { agentId: 'inst-1', toolIds: [] } });
    await waitFor(() => {
      expect(screen.getAllByText('Myra').length).toBe(2);
    });
    const selects = screen.getAllByRole('combobox');
    const analyzeSelect = selects[0]!;
    expect((analyzeSelect as HTMLSelectElement).value).toBe('inst-1');
  });

  it('renders tool toggles when an agent with tools is selected', async () => {
    renderConfig('wf-1', { analyze: { agentId: 'inst-1', toolIds: [] } });
    await waitFor(() => {
      expect(screen.getByText('web_search')).toBeTruthy();
    });
    expect(screen.getByText('code_runner')).toBeTruthy();
  });

  it('does not show tools section when agent has no capabilities', async () => {
    renderConfig('wf-1', { generate: { agentId: 'inst-2', toolIds: [] } });
    await waitFor(() => {
      expect(screen.getAllByText('Oat').length).toBe(2);
    });
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
    await waitFor(() => {
      expect(screen.getAllByText('Myra').length).toBe(2);
    });
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0]!, 'inst-1');
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls updateStepConfig with correct payload on save', async () => {
    const user = userEvent.setup();
    renderConfig('wf-1', {});
    await waitFor(() => {
      expect(screen.getAllByText('Myra').length).toBe(2);
    });
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0]!, 'inst-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(stepConfigPatches).toHaveLength(1);
    });
    const savedConfig = stepConfigPatches[0] as {
      stepConfig?: { analyze?: { agentId?: string } };
    };
    expect(savedConfig.stepConfig?.analyze?.agentId).toBe('inst-1');
  });
});

import { WorkflowStepConfig } from './WorkflowStepConfig';
