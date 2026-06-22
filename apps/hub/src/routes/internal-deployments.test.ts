import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '@intx/workflow';
import type { AgentRepoStore } from '@intx/hub-sessions';
import { LiveDeploymentsResponse } from '@workbench/tool-credentials';
import { type } from 'arktype';
import { createInternalDeploymentsRouter } from './internal-deployments';
import type { readWorkflowDefinition } from '../services/workflow-deploy';

const DOMAIN = 'abklabs.com';

// Seed rows the fake db's select chain yields. Only live rows (deletedAt
// IS NULL + non-null deploymentId) should appear; the route's WHERE clause
// is what we assert filters them, so the fake applies the same predicate.
type Row = {
  deploymentId: string | null;
  kind: string;
  deletedAt: Date | null;
};

function fakeDb(rows: Row[]) {
  const live = rows.filter((r) => r.deploymentId !== null && r.deletedAt === null);
  return {
    select: () => ({
      from: () => ({
        where: () => live.map((r) => ({ deploymentId: r.deploymentId, kind: r.kind })),
      }),
    }),
  } as unknown as Parameters<typeof createInternalDeploymentsRouter>[0];
}

function defWithSteps(stepOrder: string[]): WorkflowDefinition {
  return { id: 'wf', stepOrder } as unknown as WorkflowDefinition;
}

function makeRouter(opts: {
  rows: Row[];
  definitions?: Record<string, WorkflowDefinition>;
  readThrows?: boolean;
}) {
  const read = (async (_store: AgentRepoStore, kind: string) => {
    if (opts.readThrows) throw new Error('missing workflow.json');
    return opts.definitions?.[kind] ?? defWithSteps(['plan', 'execute']);
  }) as unknown as typeof readWorkflowDefinition;
  return createInternalDeploymentsRouter(
    fakeDb(opts.rows),
    'sidecar-token',
    {} as unknown as AgentRepoStore,
    DOMAIN,
    read
  );
}

async function get(
  router: ReturnType<typeof createInternalDeploymentsRouter>,
  token = 'sidecar-token'
): Promise<Response> {
  return router.request('/deployments/live', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('GET /deployments/live', () => {
  test('rejects an unauthorized caller', async () => {
    const res = await get(makeRouter({ rows: [] }), 'wrong');
    expect(res.status).toBe(401);
  });

  test('returns only live deployments with derived addresses, slug, and step ids', async () => {
    const res = await get(
      makeRouter({
        rows: [
          { deploymentId: 'ses_live', kind: 'wf', deletedAt: null },
          { deploymentId: 'ses_dead', kind: 'wf', deletedAt: new Date() },
          { deploymentId: null, kind: 'wf', deletedAt: null },
        ],
        definitions: { wf: defWithSteps(['plan', 'execute']) },
      })
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);

    expect(body.deployments).toHaveLength(1);
    const d = body.deployments[0]!;
    expect(d.deploymentId).toBe('ses_live');
    expect(d.supervisorAddress).toBe('ins_ses_live@abklabs.com');
    expect(d.supervisorAgentId).toBe('ins_ses_live');
    expect(d.workflowRunSlug).toBe('ins_ses_live-abklabs-com');
    expect(d.stepAgentIds).toEqual(['ins_ses_live-plan', 'ins_ses_live-execute']);
    expect(d.stepAddresses).toEqual([
      'ins_ses_live-plan@abklabs.com',
      'ins_ses_live-execute@abklabs.com',
    ]);
    expect(d.agentStateRepoIds).toEqual(['ses_live-plan', 'ses_live-execute']);
  });

  test('fails loudly (500) when a live deployment definition cannot be read', async () => {
    const res = await get(
      makeRouter({
        rows: [{ deploymentId: 'ses_live', kind: 'wf', deletedAt: null }],
        readThrows: true,
      })
    );
    expect(res.status).toBe(500);
  });

  test('returns an empty set when there are no live deployments', async () => {
    const res = await get(
      makeRouter({ rows: [{ deploymentId: 'ses_dead', kind: 'wf', deletedAt: new Date() }] })
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect(body.deployments).toEqual([]);
  });
});
