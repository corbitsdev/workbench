import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publishToolPackages } from './publish-tool-packages';

const realFetch = globalThis.fetch;

type Call = { method: string; url: string; body: unknown };

const principal = {
  principalId: 'p1',
  tenantId: 't1',
  tenantName: 'Corbits',
  tenantSlug: 'corbits',
  kind: 'user' as const,
  status: 'active' as const,
  roles: [],
};

const existingAssetRow = {
  id: 'ast_existing',
  tenantId: 't1',
  kind: 'package-registry',
  name: 'workspace-builtins',
  displayName: null,
  creatorPrincipalId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { tenantId: 't1', direct: true },
};

let calls: Call[];
let fromDir: string;

beforeEach(async () => {
  calls = [];
  fromDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-publish-'));
  await fs.writeFile(path.join(fromDir, '@workbench-tools-hackernews-0.1.0.tgz'), 'fake-bytes-a');
  await fs.writeFile(path.join(fromDir, '@workbench-tools-exa-0.1.0.tgz'), 'fake-bytes-b');
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(fromDir, { recursive: true, force: true });
});

// Stub the hub REST surface: sign-up returns 422 (user exists) → sign-in
// 200, the assets list is empty so the registry is created, and every
// tarball PUT returns a commit + integrity.
function installFetchStub(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body =
      init?.body !== undefined && typeof init.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : init?.body;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/api/auth/sign-up/email')) return json(422, { code: 'USER_ALREADY_EXISTS' });
    if (url.endsWith('/api/auth/sign-in/email')) return json(200, { user: { id: 'u1' } });
    if (url.includes('/api/me/principals')) {
      return json(200, { data: [principal], nextCursor: null });
    }
    if (url.includes('/assets?kind=package-registry')) return json(200, []);
    if (url.endsWith('/api/tenants/t1/assets')) {
      return json(201, { ...existingAssetRow, id: 'ast_reg' });
    }
    if (url.includes('/tarballs/')) return json(200, { commit: 'c1', integrity: 'sha512-xyz' });
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;
}

describe('publishToolPackages', () => {
  test('creates the registry asset and PUTs every tarball', async () => {
    installFetchStub();
    const summaries = await publishToolPackages({
      hubURL: 'https://hub.test',
      adminEmail: 'a@test',
      adminPassword: 'pw',
      tenantSlug: 'corbits',
      tenantName: 'Corbits',
      registryName: 'workspace-builtins',
      fromDir,
    });

    expect(summaries.map((s) => s.filename).sort()).toEqual([
      '@workbench-tools-exa-0.1.0.tgz',
      '@workbench-tools-hackernews-0.1.0.tgz',
    ]);
    expect(summaries.every((s) => s.commit === 'c1' && s.integrity === 'sha512-xyz')).toBe(true);

    const created = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/api/tenants/t1/assets')
    );
    expect(created?.body).toEqual({ kind: 'package-registry', name: 'workspace-builtins' });

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.every((c) => c.url.includes('/api/tenants/t1/assets/ast_reg/tarballs/'))).toBe(
      true
    );
  });

  test('reuses an existing registry asset instead of creating one', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: undefined });
      const json = (status: number, data: unknown): Response =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/api/auth/sign-up/email')) return json(422, {});
      if (url.endsWith('/api/auth/sign-in/email')) return json(200, { user: { id: 'u1' } });
      if (url.includes('/api/me/principals'))
        return json(200, { data: [principal], nextCursor: null });
      if (url.includes('/assets?kind=package-registry')) {
        return json(200, [existingAssetRow]);
      }
      if (url.includes('/tarballs/')) return json(200, { commit: 'c1', integrity: 'sha512-xyz' });
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await publishToolPackages({
      hubURL: 'https://hub.test',
      adminEmail: 'a@test',
      adminPassword: 'pw',
      tenantSlug: 'corbits',
      tenantName: 'Corbits',
      registryName: 'workspace-builtins',
      fromDir,
    });
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/tenants/t1/assets'))).toBe(
      false
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('ast_existing/tarballs/'))).toBe(true);
  });

  test('uses a session cookie and skips admin sign-in', async () => {
    installFetchStub();
    await publishToolPackages({
      hubURL: 'https://hub.test',
      sessionCookie: 'better-auth.session_token=tok123',
      tenantSlug: 'corbits',
      tenantName: 'Corbits',
      registryName: 'workspace-builtins',
      fromDir,
    });
    // No sign-up/sign-in calls were made.
    expect(calls.some((c) => c.url.includes('/api/auth/'))).toBe(false);
    // The session cookie is sent on the authenticated requests.
    expect(calls.some((c) => c.url.includes('/api/me/principals'))).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });
});
