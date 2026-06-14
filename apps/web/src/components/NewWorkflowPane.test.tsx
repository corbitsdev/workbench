/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Drive the real useCreateWorkflow through the fetch boundary rather than
// module-mocking ../hooks/use-workflow. A local-module mock leaks process-wide
// under bun (mock.restore does not evict a transitively-cached module) and
// replaced the real hook in use-workflow.test. Stubbing fetch keeps the real
// hook + RecentCallsPicker running with no cross-file leakage.
const originalFetch = globalThis.fetch;

interface CreateResult {
  ok: boolean;
  status?: number;
  body: unknown;
}

let createResult: CreateResult = { ok: true, body: { id: 'wf-abc' } };
let workflowPosts: unknown[] = [];

function jsonResponse(result: { ok: boolean; status?: number; body: unknown }): Response {
  return {
    ok: result.ok,
    status: result.status ?? 200,
    headers: { get: () => null },
    json: () => Promise.resolve(result.body),
  } as unknown as Response;
}

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  createResult = { ok: true, body: { id: 'wf-abc' } };
  workflowPosts = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    if (String(url).includes('/workflows') && init?.method === 'POST') {
      workflowPosts.push(JSON.parse(String(init.body)));
      return Promise.resolve(jsonResponse(createResult));
    }
    return Promise.resolve(jsonResponse({ ok: true, body: { calls: [] } }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPane(onCreated = mock(), onClose = mock(), tenantId?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(NewWorkflowPane, {
        workflowKind: 'collateral-generation',
        onCreated,
        onClose,
        tenantId,
      })
    )
  );
}

describe('NewWorkflowPane — render', () => {
  it('renders paste and recent calls tabs', () => {
    renderPane();
    expect(screen.getByText('Paste')).toBeDefined();
    expect(screen.getByText('Recent calls')).toBeDefined();
  });

  it('shows the textarea in paste mode by default', () => {
    renderPane();
    expect(screen.getByPlaceholderText(/speaker 1/i)).toBeDefined();
  });

  it('renders a close button', () => {
    renderPane();
    expect(screen.getByRole('button', { name: /close new workflow/i })).toBeDefined();
  });
});

describe('NewWorkflowPane — close', () => {
  it('calls onClose when the close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = mock();
    renderPane(mock(), onClose);
    await user.click(screen.getByRole('button', { name: /close new workflow/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('NewWorkflowPane — paste submission', () => {
  it('shows a validation error when transcript is too short', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByPlaceholderText(/speaker 1/i), 'short');
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    expect(screen.getByText(/paste a transcript/i)).toBeDefined();
    expect(workflowPosts).toHaveLength(0);
  });

  it('calls createWorkflow with paste source and transcript', async () => {
    const user = userEvent.setup();
    const onCreated = mock();
    renderPane(onCreated);
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(workflowPosts).toHaveLength(1);
    });
    const call = workflowPosts[0] as { source: string; transcript: string };
    expect(call.source).toBe('paste');
    expect(call.transcript).toBe(longText);
  });

  it('passes tenantId when creating a workflow for a workbench', async () => {
    const user = userEvent.setup();
    renderPane(mock(), mock(), 'tenant-workbench');
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(workflowPosts).toHaveLength(1);
    });
    expect(workflowPosts[0]).toMatchObject({
      source: 'paste',
      tenantId: 'tenant-workbench',
    });
  });

  it('calls onCreated with the workflow id on success', async () => {
    const user = userEvent.setup();
    const onCreated = mock();
    renderPane(onCreated);
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('wf-abc');
    });
  });

  it('shows an error message when creation fails', async () => {
    createResult = { ok: false, status: 500, body: { error: 'Server error' } };
    const user = userEvent.setup();
    renderPane();
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeDefined();
    });
  });
});

describe('NewWorkflowPane — mode switching', () => {
  it('switches to recent calls mode and shows the picker', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: /recent calls/i }));
    await waitFor(() => {
      expect(screen.queryByText(/no recent calls found/i)).not.toBeNull();
    });
  });
});

import { NewWorkflowPane } from './NewWorkflowPane';
