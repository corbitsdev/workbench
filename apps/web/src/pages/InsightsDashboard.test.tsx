/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
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
    expect(screen.getByText('Tool calls')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
  });
});