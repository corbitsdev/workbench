import { describe, expect, it, mock } from 'bun:test';
import type { DB } from '@intx/db';
import { AGENTS_HUB_TOOLS, createAgentsTools, LIST_AGENTS_DEFINITION } from './index';

function makeContext(rows: unknown[]) {
  let limitArg = -1;

  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => {
      limitArg = n;
      return Promise.resolve(rows);
    },
  };

  const db = {
    select: mock(() => chain),
  } as unknown as DB['db'];

  return {
    context: { db, tenantId: 'tnt_1' },
    getLimit: () => limitArg,
  };
}

function handler(context: { db: DB['db']; tenantId: string }) {
  const tool = createAgentsTools(context)[0];
  if (!tool?.handler) throw new Error('expected a handler');
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve((tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args));
}

describe('LIST_AGENTS_DEFINITION', () => {
  it('takes no required arguments and is registered under list_agents', () => {
    expect(LIST_AGENTS_DEFINITION.inputSchema.required).toEqual([]);
    expect(AGENTS_HUB_TOOLS.list_agents.definition).toBe(LIST_AGENTS_DEFINITION);
  });
});

describe('list_agents handler', () => {
  it('returns the agent directory rows from the query', async () => {
    const rows = [
      {
        instanceId: 'ins_2',
        name: 'Myra',
        address: 'ins_2@acme.interchange',
        status: 'running',
        agentDefinitionId: 'agt_myra',
      },
      {
        instanceId: 'ins_1',
        name: 'Oat',
        address: 'ins_1@acme.interchange',
        status: 'stopped',
        agentDefinitionId: 'agt_oat',
      },
    ];
    const { context, getLimit } = makeContext(rows);

    const result = JSON.parse((await handler(context)({})) as string);

    expect(result).toEqual({ agents: rows });
    expect(getLimit()).toBe(50);
  });

  it('clamps the limit to the allowed range', async () => {
    const { context, getLimit } = makeContext([]);
    await handler(context)({ limit: 9999 });
    expect(getLimit()).toBe(200);
  });

  it('accepts a valid status filter', async () => {
    const rows = [
      {
        instanceId: 'ins_2',
        name: 'Myra',
        address: 'ins_2@acme.interchange',
        status: 'running',
        agentDefinitionId: 'agt_myra',
      },
    ];
    const { context } = makeContext(rows);
    expect(JSON.parse((await handler(context)({ status: 'running' })) as string)).toEqual({
      agents: rows,
    });
  });

  it('rejects an unknown status', async () => {
    const { context } = makeContext([]);
    await expect(handler(context)({ status: 'banana' })).rejects.toThrow(/status must be one of/);
  });
});
