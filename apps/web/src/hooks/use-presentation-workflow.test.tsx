/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGammaTemplates } from './use-presentation-workflow';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const mockFetch = mock<(input?: unknown, init?: unknown) => Promise<Response>>(() =>
  Promise.resolve(jsonResponse([]))
);

function Probe({ enabled }: { enabled: boolean }) {
  const { isFetching } = useGammaTemplates({ enabled });
  return React.createElement('span', null, isFetching ? 'fetching' : 'idle');
}

function renderProbe(enabled: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { enabled }))
  );
}

beforeEach(() => {
  // happy-dom defaults to a null origin, which breaks the URL the api client
  // builds; give it a real origin so fetch is reached.
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => Promise.resolve(jsonResponse([])));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('useGammaTemplates enabled gating (CL-1907)', () => {
  it('does not fetch templates when the presentation panel is closed', () => {
    renderProbe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches templates once enabled', async () => {
    renderProbe(true);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('/workflows/gamma/templates');
  });
});
