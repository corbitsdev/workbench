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

mock.module('../lib/hub-api', () => ({
  getAnalyticsSummary: () =>
    Promise.resolve({
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
    }),
  getAnalyticsSummaryByAgent: () =>
    Promise.resolve([
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
    ]),
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
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getAllByText('Tool calls').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('4')).toBeDefined();
  });

  it('renders per-agent breakdown when by-agent data is available', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Myra')).toBeDefined();
    });
    expect(screen.getByText('10')).toBeDefined();
  });
});
