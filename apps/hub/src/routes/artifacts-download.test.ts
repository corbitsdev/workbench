import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createWorkflowRouter } from './workflow';
import type { HubDb } from '../db';

mock.module('../config', () => ({
  getConfig: mock(() => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  })),
  loadConfig: mock(() => {}),
}));

const GLOBAL_TENANT = { id: 'tenant-global', slug: 'global-org' };
const MEMBER_PRINCIPAL = { id: 'prn-1', tenantId: 'tenant-global', kind: 'user' };

type ArtifactRow = {
  id: string;
  tenantId: string | null;
  kind: string;
  title: string;
  content: string;
} | null;

function buildApp(options: {
  artifact: ArtifactRow;
  principals?: Array<Record<string, unknown> | null>;
}) {
  const principalQueue = [...(options.principals ?? [MEMBER_PRINCIPAL])];
  const db = {
    query: {
      tenant: { findFirst: mock(() => GLOBAL_TENANT) },
      principal: {
        findFirst: mock(() => (principalQueue.length > 0 ? principalQueue.shift() : null)),
      },
      artifact: { findFirst: mock(() => options.artifact) },
    },
  } as unknown as HubDb;

  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  parent.route('/', createWorkflowRouter(db));
  return parent;
}

describe('GET /artifacts/:id/download', () => {
  it('streams a csv-export artifact as an attachment', async () => {
    const app = buildApp({
      artifact: {
        id: 'a-1',
        tenantId: 'tenant-global',
        kind: 'csv-export',
        title: 'My Export',
        content: 'product_slug,chosen_title\nfoo,Bar\n',
      },
    });
    const res = await app.request('/artifacts/a-1/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="My Export.csv"');
    expect(await res.text()).toBe('product_slug,chosen_title\nfoo,Bar\n');
  });

  it('rejects a non-downloadable kind with 400', async () => {
    const app = buildApp({
      artifact: {
        id: 'a-2',
        tenantId: 'tenant-global',
        kind: 'selection',
        title: 'Row 1',
        content: '{}',
      },
    });
    const res = await app.request('/artifacts/a-2/download');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the artifact does not exist', async () => {
    const app = buildApp({ artifact: null });
    const res = await app.request('/artifacts/missing/download');
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller cannot access the artifact tenant', async () => {
    const app = buildApp({
      artifact: {
        id: 'a-3',
        tenantId: 'other-tenant',
        kind: 'csv-export',
        title: 'Secret',
        content: 'x',
      },
      // getUserContext resolves the global principal; the other-tenant lookup fails.
      principals: [MEMBER_PRINCIPAL, null],
    });
    const res = await app.request('/artifacts/a-3/download');
    expect(res.status).toBe(403);
  });
});
