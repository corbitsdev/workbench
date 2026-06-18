/// <reference types="bun" />
import '../../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AbComparisonNewPane } from './AbComparisonNewPane';

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; json?: unknown }> = [];

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
  calls = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const entry: (typeof calls)[number] = { url: String(url), method };
    if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    calls.push(entry);
    if (String(url).includes('/workflows/credentials')) {
      return Promise.resolve(
        jsonResponse(true, [
          {
            id: 'cred-1',
            name: 'OpenAI',
            providerName: 'OpenAI',
            providerPlugin: 'openai',
            baseURL: 'https://api.openai.com/v1',
            model: 'gpt-4o',
          },
          {
            id: 'cred-2',
            name: 'Anthropic',
            providerName: 'Anthropic',
            providerPlugin: 'anthropic',
            baseURL: 'https://api.anthropic.com',
            model: 'claude-sonnet-4',
          },
        ])
      );
    }
    if (String(url).includes('/workflows') && method === 'POST') {
      return Promise.resolve(
        jsonResponse(true, { id: 'wf-ab', status: 'pending', kind: 'blind-ab-comparison' }, 201)
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(AbComparisonNewPane, {
        workflowKind: 'blind-ab-comparison',
        tenantId: 'tenant-1',
        onCreated,
        onClose: mock(() => {}),
      })
    )
  );
  return onCreated;
}

function nextButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')];
  const match = buttons.find((button) => button.textContent?.trim().toLowerCase() === 'next');
  if (!match) throw new Error('Next button not found');
  return match as HTMLButtonElement;
}

async function advanceToInputStep(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(document.querySelectorAll('select').length).toBeGreaterThanOrEqual(2);
  });
  const selects = document.querySelectorAll('select');
  await user.selectOptions(selects[0] as HTMLSelectElement, 'cred-1');
  await user.selectOptions(selects[1] as HTMLSelectElement, 'cred-2');
  await user.click(nextButton());
  await user.click(nextButton());
}

describe('AbComparisonNewPane', () => {
  it('creates the workflow through the shared api helper', async () => {
    const user = userEvent.setup();
    const onCreated = renderPane();
    await advanceToInputStep(user);
    await waitFor(() => {
      expect(
        document.querySelector('textarea[placeholder*="prompt you want to run"]')
      ).not.toBeNull();
    });
    const textarea = document.querySelector(
      'textarea[placeholder*="prompt you want to run"]'
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'Run this across providers');
    const runButton = [...document.querySelectorAll('button')].find((button) =>
      /run comparison/i.test(button.textContent ?? '')
    ) as HTMLButtonElement;
    await user.click(runButton);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('wf-ab'));
    const createCall = calls.find((c) => c.url.includes('/workflows') && c.method === 'POST');
    expect(createCall).toBeDefined();
    expect(createCall?.url).toContain('/api/v1/workflows');
    expect(createCall?.url).not.toMatch(/^\/api\//);
    expect(createCall?.json).toMatchObject({
      workflowKind: 'blind-ab-comparison',
      tenantId: 'tenant-1',
      providers: [
        expect.objectContaining({
          credentialId: 'cred-1',
          providerPlugin: 'openai',
          model: 'gpt-5.5',
        }),
        expect.objectContaining({
          credentialId: 'cred-2',
          providerPlugin: 'anthropic',
          model: 'claude-opus-4-8',
        }),
      ],
      input: { source: 'text', text: 'Run this across providers' },
    });
  });

  it('lets the user pick a catalog model per comparison slot', async () => {
    const user = userEvent.setup();
    renderPane();
    await waitFor(() => {
      expect(document.querySelectorAll('select').length).toBeGreaterThanOrEqual(2);
    });
    const selects = document.querySelectorAll('select');
    await user.selectOptions(selects[0] as HTMLSelectElement, 'cred-1');
    await user.selectOptions(selects[1] as HTMLSelectElement, 'cred-2');
    await waitFor(() => {
      expect(document.querySelectorAll('select').length).toBe(4);
    });
    const modelSelects = [...document.querySelectorAll('select')].filter((select) =>
      [...(select as HTMLSelectElement).options].some((option) => option.value === 'gpt-5.4-mini')
    );
    expect(modelSelects.length).toBeGreaterThanOrEqual(1);
    await user.selectOptions(modelSelects[0] as HTMLSelectElement, 'gpt-5.4-mini');
    expect((modelSelects[0] as HTMLSelectElement).value).toBe('gpt-5.4-mini');
  });

  it('does not include customSkills or skillIds in the submission', async () => {
    const user = userEvent.setup();
    const onCreated = renderPane();
    await advanceToInputStep(user);
    await waitFor(() => {
      expect(
        document.querySelector('textarea[placeholder*="prompt you want to run"]')
      ).not.toBeNull();
    });
    const textarea = document.querySelector(
      'textarea[placeholder*="prompt you want to run"]'
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'Run this across providers');
    const runButton = [...document.querySelectorAll('button')].find((button) =>
      /run comparison/i.test(button.textContent ?? '')
    ) as HTMLButtonElement;
    await user.click(runButton);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('wf-ab'));
    const createCall = calls.find((c) => c.url.includes('/workflows') && c.method === 'POST');
    const createJson = createCall?.json as { providers: Array<Record<string, unknown>> };
    for (const provider of createJson.providers) {
      expect('customSkills' in provider).toBe(false);
      expect('skillIds' in provider).toBe(false);
    }
  });

  it('submits selected reusable skill versions per comparison', async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const entry: (typeof calls)[number] = { url: String(url), method };
      if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
      calls.push(entry);
      if (String(url).includes('/workflows/credentials')) {
        return Promise.resolve(
          jsonResponse(true, [
            {
              id: 'cred-1',
              name: 'OpenAI',
              providerName: 'OpenAI',
              providerPlugin: 'openai',
              baseURL: 'https://api.openai.com/v1',
              model: 'gpt-4o',
            },
            {
              id: 'cred-2',
              name: 'Anthropic',
              providerName: 'Anthropic',
              providerPlugin: 'anthropic',
              baseURL: 'https://api.anthropic.com',
              model: 'claude-sonnet-4',
            },
          ])
        );
      }
      if (String(url).includes('/skills')) {
        return Promise.resolve(
          jsonResponse(true, {
            skills: [
              {
                id: 'skill-1',
                name: 'ASAP',
                description: null,
                visibility: 'workspace',
                latestVersionId: 'sv-1',
                latestVersion: 2,
                createdAt: '2026-06-17T00:00:00.000Z',
                updatedAt: '2026-06-17T00:00:00.000Z',
              },
            ],
          })
        );
      }
      if (String(url).includes('/workflows') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(true, { id: 'wf-ab', status: 'pending', kind: 'blind-ab-comparison' }, 201)
        );
      }
      return Promise.resolve(jsonResponse(true, {}));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    const onCreated = renderPane();
    await waitFor(() => {
      expect(document.querySelectorAll('select').length).toBeGreaterThanOrEqual(2);
    });
    const selects = document.querySelectorAll('select');
    await user.selectOptions(selects[0] as HTMLSelectElement, 'cred-1');
    await user.selectOptions(selects[1] as HTMLSelectElement, 'cred-2');
    await user.click(nextButton());
    await waitFor(() => expect(document.body.textContent).toContain('ASAP v2'));
    await user.click(
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'ASAP v2'
      ) as HTMLButtonElement
    );
    await user.click(nextButton());
    await waitFor(() => {
      expect(
        document.querySelector('textarea[placeholder*="prompt you want to run"]')
      ).not.toBeNull();
    });
    await user.type(
      document.querySelector(
        'textarea[placeholder*="prompt you want to run"]'
      ) as HTMLTextAreaElement,
      'Run this across providers'
    );
    await user.click(
      [...document.querySelectorAll('button')].find((button) =>
        /run comparison/i.test(button.textContent ?? '')
      ) as HTMLButtonElement
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('wf-ab'));
    const createCall = calls.find((c) => c.url.includes('/workflows') && c.method === 'POST');
    const createJson = createCall?.json as { providers: Array<{ skillVersionIds?: string[] }> };
    expect(createJson.providers[0].skillVersionIds).toEqual(['sv-1']);
  });

  it('surfaces a server error when workflow creation fails', async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (String(url).includes('/workflows/credentials')) {
        return Promise.resolve(
          jsonResponse(true, [
            {
              id: 'cred-1',
              name: 'OpenAI',
              providerName: 'OpenAI',
              providerPlugin: 'openai',
              baseURL: 'https://api.openai.com/v1',
            },
            {
              id: 'cred-2',
              name: 'Anthropic',
              providerName: 'Anthropic',
              providerPlugin: 'anthropic',
              baseURL: 'https://api.anthropic.com',
            },
          ])
        );
      }
      if (String(url).includes('/workflows') && method === 'POST') {
        return Promise.resolve(jsonResponse(false, { error: 'Workflow kind not enabled' }, 400));
      }
      return Promise.resolve(jsonResponse(true, {}));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPane();
    await advanceToInputStep(user);
    await waitFor(() => {
      expect(
        document.querySelector('textarea[placeholder*="prompt you want to run"]')
      ).not.toBeNull();
    });
    const textarea = document.querySelector(
      'textarea[placeholder*="prompt you want to run"]'
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'Run this across providers');
    const runButton = [...document.querySelectorAll('button')].find((button) =>
      /run comparison/i.test(button.textContent ?? '')
    ) as HTMLButtonElement;
    await user.click(runButton);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Workflow kind not enabled');
    });
  });
});
