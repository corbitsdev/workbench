import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createUploadsRouter, MAX_UPLOAD_BYTES } from './uploads';
import type { HubDb } from '../db';

mock.module('../config', () => ({
  getConfig: mock(() => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  })),
  loadConfig: mock(() => {}),
}));

const GLOBAL_TENANT = { id: 'tenant-global', slug: 'global-org' };
const MEMBER_PRINCIPAL = { id: 'prn-1', tenantId: 'tenant-global', kind: 'user' };

function buildApp(options: { onInsert?: (values: Record<string, unknown>) => void } = {}) {
  const db = {
    query: {
      tenant: { findFirst: mock(() => GLOBAL_TENANT) },
      principal: { findFirst: mock(() => MEMBER_PRINCIPAL) },
    },
    insert: mock(() => ({
      values: mock((values: Record<string, unknown>) => {
        options.onInsert?.(values);
        return { returning: mock(() => [{ id: 'upl-1' }]) };
      }),
    })),
  } as unknown as HubDb;

  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  parent.route('/', createUploadsRouter(db));
  return parent;
}

function uploadRequest(file: File | null) {
  const form = new FormData();
  if (file) form.set('file', file);
  return new Request('http://local/uploads', { method: 'POST', body: form });
}

describe('POST /uploads', () => {
  it('stores the file and returns its metadata', async () => {
    let inserted: Record<string, unknown> | undefined;
    const app = buildApp({ onInsert: (v) => (inserted = v) });
    const file = new File(['col1,col2\n'], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const res = await app.request(uploadRequest(file));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      uploadId: 'upl-1',
      filename: 'data.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: file.size,
    });
    expect(inserted?.tenantId).toBe('tenant-global');
    expect(inserted?.principalId).toBe('prn-1');
    expect(Buffer.isBuffer(inserted?.content)).toBe(true);
  });

  it('rejects a file over the size limit with 413', async () => {
    const app = buildApp();
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.xlsx', {
      type: 'application/octet-stream',
    });
    const res = await app.request(uploadRequest(big));
    expect(res.status).toBe(413);
  });

  it('returns 400 when no file is provided', async () => {
    const app = buildApp();
    const res = await app.request(uploadRequest(null));
    expect(res.status).toBe(400);
  });

  it('rejects a non-xlsx file with 415', async () => {
    const app = buildApp();
    const pdf = new File(['%PDF-1.4'], 'catalog.pdf', { type: 'application/pdf' });
    const res = await app.request(uploadRequest(pdf));
    expect(res.status).toBe(415);
  });

  it('accepts an .xlsx file by extension even without the canonical MIME', async () => {
    const app = buildApp();
    const file = new File(['data'], 'catalog.xlsx', { type: '' });
    const res = await app.request(uploadRequest(file));
    expect(res.status).toBe(201);
  });
});
