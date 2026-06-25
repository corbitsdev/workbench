/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

mock.module('../lib/hub-api', () => ({
  getMe: () =>
    Promise.resolve({
      userId: 'u1',
      userName: 'Test User',
      personalTenantId: 'tenant-1',
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
    }),
}));

mock.module('react-router', () => ({
  useNavigate: () => mock(() => {}),
  useParams: () => ({ name: 'attio_query_records' }),
}));

import { ToolDetail } from './ToolDetail';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const toolWithVersion = {
  name: 'attio_query_records',
  providerName: 'attio',
  description: 'Find records.',
  inputSchema: { type: 'object', properties: {} },
  version: '0.2.3',
};

beforeEach(() => {
  window.happyDOM.setURL('http://localhost/tools/attio_query_records');
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(ToolDetail)));
}

describe('ToolDetail', () => {
  it('shows version badge when tool has a resolved version', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ tool: toolWithVersion }))
    ) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain('attio_query_records'));
    expect(document.body.textContent).toContain('v0.2.3');
  });

  it('shows Tool not found message on 404', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ error: 'Tool not found' }, 404))
    ) as unknown as typeof fetch;

    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("isn't available for your workbench")
    );
  });
});
