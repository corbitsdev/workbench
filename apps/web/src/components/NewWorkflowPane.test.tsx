/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// framer-motion stub — avoids animation side-effects in tests.
mock.module('framer-motion', () => ({
  motion: {
    form: ({
      children,
      className,
      onSubmit,
    }: {
      children: React.ReactNode;
      className?: string;
      onSubmit?: React.FormEventHandler;
    }) => React.createElement('form', { className, onSubmit }, children),
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// Stub RecentCallsPicker — it makes network calls we don't need here.
mock.module('./RecentCallsPicker', () => ({
  default: ({ onSelect, isLoading }: { onSelect: (data: unknown) => void; isLoading: boolean }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'recent-calls-picker',
        disabled: isLoading,
        onClick: () => onSelect({ source: 'granola', granolaId: 'note-123' }),
      },
      'Pick recent call'
    ),
}));

const mockMutateAsync = mock<(body: unknown) => Promise<{ id: string }>>();

mock.module('../hooks/use-workflow', () => ({
  useCreateWorkflow: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

import { NewWorkflowPane } from './NewWorkflowPane';

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

afterEach(() => {
  cleanup();
  mockMutateAsync.mockClear();
});

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
  beforeEach(() => {
    mockMutateAsync.mockResolvedValue({ id: 'wf-abc' });
  });

  it('shows a validation error when transcript is too short', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByPlaceholderText(/speaker 1/i), 'short');
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    expect(screen.getByText(/paste a transcript/i)).toBeDefined();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('calls createWorkflow with paste source and transcript', async () => {
    const user = userEvent.setup();
    const onCreated = mock();
    renderPane(onCreated);
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    const call = mockMutateAsync.mock.calls[0][0] as { source: string; transcript: string };
    expect(call.source).toBe('paste');
    expect(call.transcript).toBe(longText);
  });

  it('passes tenantId when creating a workflow for a workspace', async () => {
    const user = userEvent.setup();
    renderPane(mock(), mock(), 'tenant-workspace');
    const longText = 'Speaker 1: Thanks for taking the time today to discuss your challenges.';
    await user.type(screen.getByPlaceholderText(/speaker 1/i), longText);
    await user.click(screen.getByRole('button', { name: /start analysis/i }));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
      source: 'paste',
      tenantId: 'tenant-workspace',
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
    mockMutateAsync.mockRejectedValue(new Error('Server error'));
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
    expect(screen.getByTestId('recent-calls-picker')).toBeDefined();
  });
});
