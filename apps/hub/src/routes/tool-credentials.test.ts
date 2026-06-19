import { describe, expect, test } from 'bun:test';
import type { resolveCredentialRequirement } from '@intx/db';
import { createToolCredentialsRouter } from './tool-credentials';

// 'exa'/'firecrawl' resolve to a secret; 'github' resolves to null (no
// credential configured). These providers map from the agent's capabilities
// (exa_search→exa, firecrawl_scrape→firecrawl, github_activity→github).
const fakeResolve = (async (_db: unknown, _tenantId: string, req: { providerName: string }) => {
  if (req.providerName === 'github') return null;
  return { secret: `secret-${req.providerName}`, providerId: `prov-${req.providerName}` };
}) as unknown as typeof resolveCredentialRequirement;

const agentCapabilities = { tools: ['exa_search', 'firecrawl_scrape', 'github_activity'] };

const fakeDb = {
  query: {
    agent: { findFirst: async () => ({ id: 'a1', capabilities: agentCapabilities }) },
    provider: { findFirst: async () => ({ metadata: { baseURL: 'https://api.example' } }) },
  },
} as unknown as Parameters<typeof createToolCredentialsRouter>[0];

const router = createToolCredentialsRouter(fakeDb, 'sidecar-token', fakeResolve);

async function post(body: unknown, token = 'sidecar-token'): Promise<Response> {
  return await router.request('/tools/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const req = (providerNames: string[]) => ({ tenantId: 't1', agentId: 'a1', providerNames });

describe('POST /tools/credentials', () => {
  test('rejects an unauthorized caller', async () => {
    expect((await post(req(['exa']), 'wrong')).status).toBe(401);
  });

  test('resolves providers the agent is allowed to use', async () => {
    const res = await post(req(['exa', 'firecrawl']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({
      exa: { apiKey: 'secret-exa', baseURL: 'https://api.example' },
      firecrawl: { apiKey: 'secret-firecrawl', baseURL: 'https://api.example' },
    });
  });

  test('rejects a provider the agent is not allowed to request (403)', async () => {
    // youtube_search is not in the agent's capabilities, so youtube is forbidden.
    expect((await post(req(['youtube']))).status).toBe(403);
  });

  test('returns 422 for an allowed provider with no configured credential', async () => {
    expect((await post(req(['github']))).status).toBe(422);
  });

  test('returns 400 on a malformed request body', async () => {
    expect((await post({ tenantId: 't1', agentId: 'a1' })).status).toBe(400);
  });
});
