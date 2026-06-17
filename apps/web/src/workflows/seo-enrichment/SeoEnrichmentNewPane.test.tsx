/// <reference types="bun" />
import '../../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeoEnrichmentNewPane } from './SeoEnrichmentNewPane';

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

const originalFetch = globalThis.fetch;
let uploadOk = true;
let calls: Array<{ url: string; method: string; bodyIsFormData: boolean; json?: unknown }> = [];

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  window.happyDOM.setURL('http://localhost/');
  uploadOk = true;
  calls = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const bodyIsFormData = init?.body instanceof FormData;
    const entry: (typeof calls)[number] = { url: String(url), method, bodyIsFormData };
    if (!bodyIsFormData && typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    calls.push(entry);
    if (String(url).includes('/uploads')) {
      return Promise.resolve(
        jsonResponse(
          uploadOk,
          uploadOk
            ? { uploadId: 'upl-1', filename: 'catalog.xlsx', mimeType: 'x', size: 2048 }
            : { error: 'too big' }
        )
      );
    }
    if (String(url).includes('/workflows')) {
      return Promise.resolve(
        jsonResponse(true, { id: 'wf-1', status: 'running', kind: 'seo-enrichment' })
      );
    }
    return Promise.resolve(jsonResponse(true, {}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPane(onCreated = mock(() => {})) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SeoEnrichmentNewPane, {
        workflowKind: 'seo-enrichment',
        tenantId: 'tenant-1',
        onCreated,
        onClose: mock(() => {}),
      })
    )
  );
  return onCreated;
}

const xlsx = () =>
  new File(['data'], 'catalog.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

describe('SeoEnrichmentNewPane', () => {
  it('uploads the selected file and shows its name and size', async () => {
    renderPane();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, xlsx());
    await screen.findByText(/catalog\.xlsx/);
    const uploadCall = calls.find((c) => c.url.includes('/uploads') && c.bodyIsFormData);
    expect(uploadCall).toBeDefined();
    expect(uploadCall?.url).toContain('tenantId=tenant-1');
  });

  it('creates the workflow with the returned uploadId', async () => {
    const onCreated = renderPane();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, xlsx());
    await screen.findByText(/catalog\.xlsx/);
    await userEvent.click(screen.getByRole('button', { name: /start enrichment/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('wf-1'));
    const createCall = calls.find((c) => c.url.includes('/workflows') && c.method === 'POST');
    expect(createCall?.json).toMatchObject({ workflowKind: 'seo-enrichment', uploadId: 'upl-1' });
  });

  it('surfaces an upload error', async () => {
    uploadOk = false;
    renderPane();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, xlsx());
    await screen.findByText(/too big/);
  });
});
