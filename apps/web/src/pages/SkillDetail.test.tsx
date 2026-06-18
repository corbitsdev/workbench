/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  useParams: () => ({ id: 'skill-1' }),
}));

import { SkillDetail } from './SkillDetail';

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; json?: unknown }> = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const skill = {
  id: 'skill-1',
  name: 'asap',
  displayName: 'ASAP',
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
  scope: 'tenant',
  accessTenantId: 'tenant-root',
  ownerUserId: 'usr-1',
  ownerName: 'Ada Lovelace',
};

const versions = [
  {
    sha: 'sha-2',
    shortSha: 'bbbbbbb',
    version: 2,
    message: 'second',
    authorName: 'Ada Lovelace',
    createdAt: '2026-06-17T01:00:00.000Z',
  },
  {
    sha: 'sha-1',
    shortSha: 'aaaaaaa',
    version: 1,
    message: 'first',
    authorName: 'Ada Lovelace',
    createdAt: '2026-06-16T00:00:00.000Z',
  },
];

beforeEach(() => {
  window.happyDOM.setURL('http://localhost/');
  calls = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const entry: (typeof calls)[number] = { url: String(url), method };
    if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    calls.push(entry);
    if (String(url).includes('/skills/skill-1/versions')) {
      return Promise.resolve(jsonResponse({ versions, total: versions.length }));
    }
    if (String(url).includes('/skills/skill-1/restore')) {
      return Promise.resolve(jsonResponse({ skill }));
    }
    if (String(url).includes('/skills/skill-1')) {
      return Promise.resolve(
        jsonResponse({ skill, files: [{ path: 'SKILL.md', content: '# ASAP' }] })
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(SkillDetail)));
}

describe('SkillDetail', () => {
  it('lists versions newest-first and marks the latest as current', async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain('Version history'));
    expect(document.body.textContent).toContain('v2');
    expect(document.body.textContent).toContain('bbbbbbb');
    expect(document.body.textContent).toContain('current');
  });

  it('restores a non-latest version via the restore endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain('Version history'));

    const restoreButton = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore'
    ) as HTMLButtonElement;
    await user.click(restoreButton);

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/restore') && c.method === 'POST')).toBe(true);
    });
    const restoreCall = calls.find((c) => c.url.includes('/restore'));
    expect(restoreCall?.json).toMatchObject({ sha: 'sha-1' });
  });
});
