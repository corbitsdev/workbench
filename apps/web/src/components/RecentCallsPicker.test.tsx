/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import RecentCallsPicker from './RecentCallsPicker';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const mockFetch = mock(() => Promise.resolve(jsonResponse({ calls: [] })));

function renderPicker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(RecentCallsPicker, {
        onSelect: () => {},
        tenantId: 'tn-1',
        kind: 'presentation-generation',
      })
    )
  );
}

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ calls: [] })));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('RecentCallsPicker', () => {
  it('renders fetched calls once the query resolves', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          calls: [
            {
              id: 'call-1',
              title: 'Discovery with Acme',
              created_at: new Date().toISOString(),
              participants: [],
            },
          ],
        })
      )
    );
    const view = renderPicker();
    await waitFor(() => view.getByText('Discovery with Acme'));
    const requestedUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('recent-calls');
    expect(requestedUrl).toContain('tenantId=tn-1');
  });

  it('renders the empty state when no calls are returned', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ calls: [] })));
    const view = renderPicker();
    await waitFor(() => view.getByText(/no recent calls found/i));
  });

  it('surfaces the error state when the fetch fails', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'granola down' }, false))
    );
    const view = renderPicker();
    await waitFor(() => view.getByText('granola down'));
  });
});
