import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import {
  buildSelectionArtifactContent,
  parseSelectionArtifactContent,
} from '@workbench/gtm-workflows';
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

const SELECTION_CONTENT = buildSelectionArtifactContent({
  label: 'Row 1',
  fields: { Title: ['t1', 't2', 't3', 't4', 't5'], Description: ['d1', 'd2', 'd3', 'd4', 'd5'] },
  chosen: null,
});

function buildApp(options: {
  workflow?: Record<string, unknown> | null;
  artifact?: Record<string, unknown> | null;
}) {
  const wf =
    options.workflow === undefined
      ? {
          id: 'wf-1',
          tenantId: 'tenant-global',
          principalId: 'prn-1',
          status: 'reviewing',
          kind: 'seo-enrichment',
        }
      : options.workflow;
  const art =
    options.artifact === undefined
      ? {
          id: 'a-1',
          sessionId: 'wf-1',
          kind: 'selection',
          title: 'Row 1',
          content: SELECTION_CONTENT,
          status: 'draft',
        }
      : options.artifact;

  const captured: { content?: string } = {};
  const db = {
    query: {
      tenant: { findFirst: mock(() => GLOBAL_TENANT) },
      principal: { findFirst: mock(() => MEMBER_PRINCIPAL) },
      workflowRun: { findFirst: mock(() => wf) },
      artifact: { findFirst: mock(() => art) },
    },
    transaction: mock((fn: (tx: unknown) => unknown) =>
      fn({
        // `.where()` is awaited directly for the max-version query and chained
        // with `.for('update')` for the row-locked content re-read.
        select: () => ({
          from: () => ({
            where: () => {
              const result: Promise<unknown[]> & { for?: () => Promise<unknown[]> } =
                Promise.resolve([{ maxVersion: 1 }]);
              result.for = () => Promise.resolve([{ content: art?.content ?? SELECTION_CONTENT }]);
              return result;
            },
          }),
        }),
        update: () => ({
          set: (values: { content: string; version: number }) => {
            captured.content = values.content;
            return {
              where: () => ({
                returning: () =>
                  Promise.resolve([
                    { id: 'a-1', sessionId: 'wf-1', kind: 'selection', title: 'Row 1', ...values },
                  ]),
              }),
            };
          },
        }),
        insert: () => ({ values: () => Promise.resolve() }),
      })
    ),
  } as unknown as HubDb;

  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  parent.route('/', createWorkflowRouter(db));
  return { app: parent, captured };
}

function patch(chosen: Record<string, number>) {
  return new Request('http://local/workflows/wf-1/artifacts/a-1/selection', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chosen }),
  });
}

describe('PATCH /workflows/:id/artifacts/:artifactId/selection', () => {
  it('writes the chosen indices and bumps the version', async () => {
    const { app, captured } = buildApp({});
    const res = await app.request(patch({ Title: 1, Description: 0 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: string; version: number };
    expect(json.version).toBe(2);
    expect(parseSelectionArtifactContent(captured.content ?? '').chosen).toEqual({
      Title: 1,
      Description: 0,
    });
  });

  it('rejects a pick that points at no option with 400', async () => {
    const { app } = buildApp({});
    const res = await app.request(patch({ Title: 99 }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-selection artifact with 400', async () => {
    const { app } = buildApp({
      artifact: { id: 'a-1', sessionId: 'wf-1', kind: 'csv-export', title: 'X', content: 'x' },
    });
    const res = await app.request(patch({ Title: 0 }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not the workflow owner', async () => {
    const { app } = buildApp({
      workflow: {
        id: 'wf-1',
        tenantId: 'tenant-global',
        principalId: 'someone-else',
        status: 'reviewing',
        kind: 'seo-enrichment',
      },
    });
    const res = await app.request(patch({ Title: 0 }));
    expect(res.status).toBe(403);
  });
});
