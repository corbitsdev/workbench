/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

let runsResult: {
  data?: unknown[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = { data: [], isLoading: false, isError: false, refetch: () => {} };

mock.module('../hooks/use-workflow', () => ({
  useWorkflowRuns: () => runsResult,
}));

mock.module('../components/WorkflowRunPane', () => ({
  WorkflowRunPane: (props: { deploymentId: string }) =>
    React.createElement('div', { 'data-testid': 'run-pane' }, props.deploymentId),
}));

mock.module('../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { WorkflowsPage } = require('./WorkflowsPage');

afterEach(() => cleanup());

describe('WorkflowsPage', () => {
  it('shows a loading state', () => {
    runsResult = { data: undefined, isLoading: true, isError: false, refetch: () => {} };
    render(React.createElement(WorkflowsPage));
    expect(screen.getByText(/loading runs/i)).toBeDefined();
  });

  it('shows an empty state when there are no runs', () => {
    runsResult = { data: [], isLoading: false, isError: false, refetch: () => {} };
    render(React.createElement(WorkflowsPage));
    expect(screen.getByText(/no workflow runs yet/i)).toBeDefined();
  });

  it('lists runs and opens the run pane on select', () => {
    runsResult = {
      data: [
        {
          runId: 'run-1',
          kind: 'deck-build',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    render(React.createElement(WorkflowsPage));
    expect(screen.getByText('deck-build')).toBeDefined();
    expect(screen.queryByTestId('run-pane')).toBeNull();
    fireEvent.click(screen.getByText('deck-build'));
    expect(screen.getByTestId('run-pane').textContent).toBe('run-1');
  });
});
