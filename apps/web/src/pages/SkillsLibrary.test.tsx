/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

import { SkillsLibrary } from './SkillsLibrary';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const skillSummary = {
  id: 'skill-1',
  name: 'ASAP',
  description: null,
  visibility: 'workspace',
  latestVersionId: 'sv-2',
  latestVersion: 2,
  source: 'folder',
  fileCount: 2,
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
};

const manifest = {
  files: [
    {
      path: 'SKILL.md',
      size: 12,
      mimeType: 'text/markdown',
      sha256: 'hash',
      promptReadable: true,
      executableLike: false,
    },
  ],
  entrypointPath: 'SKILL.md',
  totalSize: 12,
  checksum: 'checksum',
};

beforeEach(() => {
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes('/skill-versions/sv-2/preview')) {
      return Promise.resolve(
        jsonResponse({
          version: {
            id: 'sv-2',
            skillId: 'skill-1',
            version: 2,
            entrypointPath: 'SKILL.md',
            manifest,
            checksum: 'checksum',
            source: 'folder',
            createdAt: '2026-06-17T00:00:00.000Z',
          },
          files: [{ path: 'SKILL.md', content: '# ASAP' }],
        })
      );
    }
    if (String(url).includes('/skills/skill-1')) {
      return Promise.resolve(
        jsonResponse({
          skill: {
            ...skillSummary,
            versions: [
              {
                id: 'sv-2',
                skillId: 'skill-1',
                version: 2,
                entrypointPath: 'SKILL.md',
                manifest,
                checksum: 'checksum',
                source: 'folder',
                createdAt: '2026-06-17T00:00:00.000Z',
              },
            ],
          },
        })
      );
    }
    if (String(url).includes('/skills')) {
      return Promise.resolve(jsonResponse({ skills: [skillSummary] }));
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
  render(React.createElement(QueryClientProvider, { client }, React.createElement(SkillsLibrary)));
}

describe('SkillsLibrary', () => {
  it('loads skill detail versions and previews a selected version', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain('ASAP'));
    await user.click(
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('ASAP')
      ) as HTMLButtonElement
    );

    await waitFor(() => expect(document.body.textContent).toContain('v2 · folder · 1 files'));
    await waitFor(() => expect(document.body.textContent).toContain('# ASAP'));
  });
});
