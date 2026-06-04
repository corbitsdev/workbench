/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FinalExport from './FinalExport';

let mockWorkflowData: { data: unknown; isLoading: boolean } = { data: undefined, isLoading: true };

mock.module('../hooks/use-workflow', () => ({
  useWorkflow: (_id: string) => mockWorkflowData,
  useRunStep: () => ({ mutateAsync: async () => {}, isPending: false }),
  useUpdateCompanyName: () => ({ mutateAsync: async () => {} }),
  useCreateWorkflow: () => ({ mutateAsync: async () => {} }),
}));

afterEach(() => {
  cleanup();
  mockWorkflowData = { data: undefined, isLoading: true };
});

function renderFinalExport(workflowId = 'wf-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/workflows/:id/export', element: React.createElement(FinalExport) }],
    { initialEntries: [`/workflows/${workflowId}/export`] }
  );
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(RouterProvider, { router })
    )
  );
}

describe('FinalExport', () => {
  it('renders artifact cards when artifacts are present', () => {
    mockWorkflowData = {
      isLoading: false,
      data: {
        id: 'wf-1',
        status: 'done',
        currentStep: 'export',
        companyName: null,
        steps: {
          generate: {
            completed: true,
            artifacts: [
              {
                id: 'a1',
                kind: 'email',
                title: 'Follow-up to Acme',
                content: 'Hi there, following up on our call...',
                status: 'draft',
                version: 1,
                sessionId: 'wf-1',
                parentId: null,
                painPointId: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        },
      },
    };

    renderFinalExport();
    expect(screen.getByText('Follow-up to Acme')).toBeDefined();
  });

  it('shows an empty state with a back link when no artifacts are returned', () => {
    mockWorkflowData = {
      isLoading: false,
      data: {
        id: 'wf-1',
        status: 'improving',
        currentStep: 'improve',
        companyName: null,
        steps: {
          generate: { completed: false, artifacts: [] },
        },
      },
    };

    renderFinalExport();
    expect(screen.getByText(/no collateral found/i)).toBeDefined();
    expect(screen.getByRole('link', { name: /back to improvement/i })).toBeDefined();
  });
});
