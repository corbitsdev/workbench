/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('../hooks/use-workbenches', () => ({
  useWorkbenches: () => ({
    data: [
      {
        id: 'p1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme Corp',
      },
    ],
    isLoading: false,
    isSuccess: true,
    isError: false,
  }),
}));

const mockOverview = {
  tenantId: 'tenant-1',
  range: {},
  artifacts: {
    total: 5,
    createdInRange: 2,
    byStatus: [{ key: 'ready', count: 4 }],
    byKind: [{ key: 'brief', count: 3 }],
  },
  workflowRuns: {
    executionRecords: 8,
    executionsStartedInRange: 3,
    activeExecutions: 1,
    byStatus: [{ key: 'completed', count: 6 }],
    byKind: [{ key: 'call-to-collateral', count: 8 }],
    deploymentsIndexed: 2,
  },
  agentInstances: { active: 2, startedInRange: 1, endedInRange: 0, total: 4 },
  inference: {
    summary: {
      tenantId: 'tenant-1',
      turnCount: 12,
      failedTurnCount: 0,
      toolCallCount: 4,
      toolErrorCount: 0,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    byAgent: [
      {
        agentId: 'agt_myra',
        agentName: 'Myra',
        turnCount: 10,
        failedTurnCount: 0,
        toolCallCount: 3,
        toolErrorCount: 0,
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
    ],
    byInstance: [],
  },
};

mock.module('../lib/hub-api', () => ({
  getActivityOverview: () => Promise.resolve(mockOverview),
  describeHubApiFailure: (e: unknown) => String(e),
}));

import { InsightsDashboard } from './InsightsDashboard';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InsightsDashboard />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.happyDOM.setURL('http://localhost/insights');
});

afterEach(() => {
  cleanup();
});

describe('InsightsDashboard', () => {
  it('renders KPI totals from the analytics summary', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Total turns')).toBeDefined();
    });
    expect(screen.getAllByText('12').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Tool calls').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1);
  });

  it('shows success rates for turns and tool calls instead of failure or error rates', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Successful turns')).toBeDefined();
    });
    expect(screen.getByText('Successful tool calls')).toBeDefined();
    expect(screen.getAllByText('100.0% success rate').length).toBe(2);
    expect(screen.queryByText(/failure rate/)).toBeNull();
    expect(screen.queryByText(/error rate/)).toBeNull();
  });

  it('renders operational ledger totals from activity overview', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Operational ledger')).toBeDefined();
    });
    expect(screen.getByText('Artifacts (total)')).toBeDefined();
    expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Workflow executions')).toBeDefined();
    expect(screen.getAllByText('8').length).toBeGreaterThanOrEqual(1);
  });

  it('renders per-agent breakdown when by-agent data is available', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Myra')).toBeDefined();
    });
    expect(screen.getByText('10')).toBeDefined();
  });
});
