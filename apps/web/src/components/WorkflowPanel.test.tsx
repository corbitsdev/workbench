/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// framer-motion is not compatible with Happy DOM.
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// Mock the workflow hook module so tests drive state without network calls.
const mockUseWorkflow = mock(() => ({
  data: undefined as unknown,
  isLoading: true,
  isError: false,
}));

const mockRunStep = mock(() => ({
  mutateAsync: mock(() => Promise.resolve({})),
  isPending: false,
}));

mock.module('../hooks/use-workflow', () => ({
  useWorkflow: mockUseWorkflow,
  useRunStep: mockRunStep,
  useUpdateCompanyName: mock(() => ({ mutateAsync: mock(() => Promise.resolve({})) })),
  useUpdateStepConfig: mock(() => ({
    mutate: mock(() => {}),
    isPending: false,
    isError: false,
    error: null,
  })),
  useWorkbenchAgents: mock(() => ({ data: [], isLoading: false })),
}));

import { WorkflowPanel } from './WorkflowPanel';

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    status: 'pending',
    currentStep: 'analyze',
    companyName: 'Acme Corp',
    stepConfig: {},
    steps: {
      intake: { completed: true, transcriptId: 'tx-1' },
      analyze: { completed: false, painPoints: [] },
      generate: { completed: false, artifacts: [] },
    },
    ...overrides,
  };
}

const onClose = mock(() => {});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WorkflowPanel, { workflowId: 'wf-1', onClose })
    )
  );
}

afterEach(() => {
  cleanup();
  mock.restore();
});

describe('WorkflowPanel loading state', () => {
  beforeEach(() => {
    mockUseWorkflow.mockImplementation(() => ({
      data: undefined,
      isLoading: true,
      isError: false,
    }));
    mockRunStep.mockImplementation(() => ({
      mutateAsync: mock(() => Promise.resolve({})),
      isPending: false,
    }));
  });

  it('shows loading text while data is being fetched', () => {
    renderPanel();
    expect(screen.getByText(/loading workflow/i)).toBeDefined();
  });
});

describe('WorkflowPanel error state', () => {
  beforeEach(() => {
    mockUseWorkflow.mockImplementation(() => ({
      data: undefined,
      isLoading: false,
      isError: true,
    }));
    mockRunStep.mockImplementation(() => ({
      mutateAsync: mock(() => Promise.resolve({})),
      isPending: false,
    }));
  });

  it('shows error text when workflow fetch fails', () => {
    renderPanel();
    expect(screen.getByText(/could not load workflow/i)).toBeDefined();
  });
});

describe('WorkflowPanel analyze step', () => {
  beforeEach(() => {
    mockUseWorkflow.mockImplementation(() => ({
      data: makeWorkflow({ currentStep: 'analyze', status: 'pending' }),
      isLoading: false,
      isError: false,
    }));
    mockRunStep.mockImplementation(() => ({
      mutateAsync: mock(() => Promise.resolve({})),
      isPending: false,
    }));
  });

  it('shows the workflow title', () => {
    renderPanel();
    expect(screen.getByText('Acme Corp')).toBeDefined();
  });

  it('shows the horizontal stepper', () => {
    renderPanel();
    expect(screen.getByText('Analyze')).toBeDefined();
    expect(screen.getByText('Generate')).toBeDefined();
  });

  it('shows Run analysis button before pain points are extracted', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /run analysis/i })).toBeDefined();
  });
});

describe('WorkflowPanel generate step', () => {
  const painPoints = [
    {
      id: 'pp-1',
      context: 'Slow onboarding',
      quote: 'Takes weeks',
      severity: 'high' as const,
      selected: false,
    },
    {
      id: 'pp-2',
      context: 'No integrations',
      quote: 'Cannot connect',
      severity: 'medium' as const,
      selected: false,
    },
  ];

  beforeEach(() => {
    mockUseWorkflow.mockImplementation(() => ({
      data: makeWorkflow({
        currentStep: 'generate',
        status: 'generating',
        steps: {
          intake: { completed: true, transcriptId: 'tx-1' },
          analyze: { completed: true, painPoints },
          generate: { completed: false, artifacts: [] },
        },
      }),
      isLoading: false,
      isError: false,
    }));
    mockRunStep.mockImplementation(() => ({
      mutateAsync: mock(() => Promise.resolve({})),
      isPending: false,
    }));
  });

  it('shows the extracted pain points', () => {
    renderPanel();
    expect(screen.getByText('Slow onboarding')).toBeDefined();
    expect(screen.getByText('No integrations')).toBeDefined();
  });

  it('shows collateral type options', () => {
    renderPanel();
    expect(screen.getByText('Follow-up Email')).toBeDefined();
    expect(screen.getByText('Battlecard')).toBeDefined();
  });

  it('shows a Generate button after analyze completes', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /generate collateral/i })).toBeDefined();
  });
});

describe('WorkflowPanel done step', () => {
  const artifacts = [
    {
      id: 'art-1',
      kind: 'email' as const,
      title: 'Email draft',
      content: 'Dear prospect…',
      status: 'approved',
      version: 1,
    },
  ];

  beforeEach(() => {
    mockUseWorkflow.mockImplementation(() => ({
      data: makeWorkflow({
        currentStep: 'generate',
        status: 'done',
        steps: {
          intake: { completed: true, transcriptId: 'tx-1' },
          analyze: { completed: true, painPoints: [] },
          generate: { completed: true, artifacts },
        },
      }),
      isLoading: false,
      isError: false,
    }));
    mockRunStep.mockImplementation(() => ({
      mutateAsync: mock(() => Promise.resolve({})),
      isPending: false,
    }));
  });

  it('shows the completion state when all artifacts are reviewed', () => {
    renderPanel();
    expect(screen.getByText(/all artifacts reviewed/i)).toBeDefined();
  });

  it('shows all stepper steps as completed or current', () => {
    renderPanel();
    expect(screen.getByText('Generate')).toBeDefined();
  });

  it('does not show improve or export steps', () => {
    renderPanel();
    expect(screen.queryByText('Improve')).toBeNull();
    expect(screen.queryByText('Export')).toBeNull();
  });

  it('calls onClose when close button is pressed', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /close workflow/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
