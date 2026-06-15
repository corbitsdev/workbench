import { describe, expect, it, mock } from 'bun:test';
import type { DB } from '@intx/db';
import { schema as intxSchema } from '@intx/db';

// Mock the predicate builders so the conditions passed to .where() are
// inspectable plain descriptors — this lets the tests assert tenant scoping and
// the instance-id IN filter, not just the rows the mock was handed.
//
// We mock the local `./sql-predicates` seam, NOT 'drizzle-orm' directly:
// mock.module is process-global in Bun, so mocking the library leaked these
// descriptor builders into every other suite that introspects real drizzle SQL
// (workflow and agents tests), failing them order-dependently (CL-1825). Only
// list-agents.ts imports this seam, so the mock stays contained.
mock.module('./sql-predicates', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  or: (...conds: unknown[]) => ({ op: 'or', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

const {
  createListAgentsTool,
  LIST_AGENTS_DEFINITION,
  LIST_AGENTS_HUB_TOOLS,
  resolveOwnedInstanceIds,
} = await import('./list-agents');

type Cond = { op: string; col?: unknown; val?: unknown; vals?: unknown; conds?: Cond[] };

/**
 * Each `select()` corresponds to one query: it dequeues the next canned result
 * set and records the `.where()` argument for assertion. A chain is chainable
 * and awaitable so queries ending in `.limit()` and queries awaited directly
 * after `.where()` both resolve to that set.
 */
function makeDb(resultQueue: unknown[][]) {
  let index = 0;
  const wheres: Cond[] = [];
  const db = {
    select: () => {
      const result = resultQueue[index++] ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        where: (cond: Cond) => {
          wheres.push(cond);
          return chain;
        },
        orderBy: () => chain,
        limit: () => Promise.resolve(result),
        // Drizzle query builders are thenable, so a query awaited directly after
        // .where() (the owned-instances lookup) resolves without a terminal call.
        // eslint-disable-next-line unicorn/no-thenable
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as DB['db'];
  return { db, wheres };
}

const CONTEXT = { tenantId: 'tnt_1', principalId: 'prn_caller_agent' };

function hasEq(cond: Cond, col: unknown, val: unknown): boolean {
  return (cond.conds ?? []).some((c) => c.op === 'eq' && c.col === col && c.val === val);
}

function handler(db: DB['db']) {
  const tool = createListAgentsTool({ db, ...CONTEXT })[0];
  if (!tool?.handler) throw new Error('expected a handler');
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve((tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args));
}

describe('LIST_AGENTS_DEFINITION', () => {
  it('takes no required arguments and is registered under list_agents', () => {
    expect(LIST_AGENTS_DEFINITION.inputSchema.required).toEqual([]);
    expect(LIST_AGENTS_HUB_TOOLS.list_agents?.definition).toBe(LIST_AGENTS_DEFINITION);
  });
});

describe('resolveOwnedInstanceIds', () => {
  it("resolves the caller's owning member and returns instances across all tenants", async () => {
    const { db } = makeDb([
      [{ id: 'ins_caller' }], // caller instance lookup
      [{ memberPrincipalId: 'prn_user' }], // owner row lookup
      [{ refId: 'usr_1' }], // owner principal refId
      [{ id: 'prn_user' }, { id: 'prn_user_wb' }], // all user principals
      [{ instanceId: 'ins_caller' }, { instanceId: 'ins_oat' }], // owned instances
    ]);

    expect(await resolveOwnedInstanceIds(db, CONTEXT, undefined)).toEqual([
      'ins_caller',
      'ins_oat',
    ]);
  });

  it('returns null when the caller instance cannot be found (shared/admin agent)', async () => {
    const { db } = makeDb([[]]);
    expect(await resolveOwnedInstanceIds(db, CONTEXT, undefined)).toBeNull();
  });

  it('returns null when the caller instance has no owning member row', async () => {
    const { db } = makeDb([[{ id: 'ins_caller' }], []]);
    expect(await resolveOwnedInstanceIds(db, CONTEXT, undefined)).toBeNull();
  });

  it('returns null when the owner principal has no refId', async () => {
    const { db } = makeDb([[{ id: 'ins_caller' }], [{ memberPrincipalId: 'prn_user' }], []]);
    expect(await resolveOwnedInstanceIds(db, CONTEXT, undefined)).toBeNull();
  });

  it('uses explicit member principals without resolving the caller', async () => {
    const { db } = makeDb([[{ instanceId: 'ins_a' }, { instanceId: 'ins_b' }]]);
    expect(await resolveOwnedInstanceIds(db, CONTEXT, ['prn_other'])).toEqual(['ins_a', 'ins_b']);
  });

  it('scopes the caller lookup to the tenant and calling principal', async () => {
    const { db, wheres } = makeDb([[{ id: 'ins_caller' }], [], []]);
    await resolveOwnedInstanceIds(db, CONTEXT, undefined);

    expect(hasEq(wheres[0]!, intxSchema.agentInstance.tenantId, 'tnt_1')).toBe(true);
    expect(hasEq(wheres[0]!, intxSchema.agentInstance.principalId, 'prn_caller_agent')).toBe(true);
  });
});

describe('list_agents handler', () => {
  it("returns the caller's owned running agents filtered by instance ids", async () => {
    const finalRows = [
      {
        instanceId: 'ins_caller',
        name: 'Myra',
        address: 'ins_caller@acme.interchange',
        status: 'running',
        agentDefinitionId: 'agt_myra',
      },
    ];
    const { db, wheres } = makeDb([
      [{ id: 'ins_caller' }],
      [{ memberPrincipalId: 'prn_user' }],
      [{ refId: 'usr_1' }],
      [{ id: 'prn_user' }],
      [{ instanceId: 'ins_caller' }],
      finalRows,
    ]);

    expect(JSON.parse((await handler(db)({})) as string)).toEqual({ agents: finalRows });

    const finalWhere = wheres.at(-1)!;
    expect(
      (finalWhere.conds ?? [finalWhere]).some(
        (c) =>
          c.op === 'inArray' &&
          c.col === intxSchema.agentInstance.id &&
          JSON.stringify(c.vals) === JSON.stringify(['ins_caller'])
      )
    ).toBe(true);
  });

  it('fails closed (empty) when the owning member has no instances', async () => {
    const { db } = makeDb([
      [{ id: 'ins_caller' }],
      [{ memberPrincipalId: 'prn_user' }],
      [{ refId: 'usr_1' }],
      [{ id: 'prn_user' }],
      [],
    ]);
    expect(JSON.parse((await handler(db)({})) as string)).toEqual({ agents: [] });
  });

  it('fails closed (empty) for a non-member-owned caller, never tenant-wide', async () => {
    const { db } = makeDb([[]]); // caller lookup empty → owner unresolved → fail closed
    expect(JSON.parse((await handler(db)({})) as string)).toEqual({ agents: [] });
  });

  it('lists another operator agents when given member principals', async () => {
    const finalRows = [
      {
        instanceId: 'ins_x',
        name: 'Myra',
        address: 'ins_x@acme.interchange',
        status: 'running',
        agentDefinitionId: 'agt_myra',
      },
    ];
    const { db } = makeDb([[{ instanceId: 'ins_x' }], finalRows]);
    expect(JSON.parse((await handler(db)({ principals: ['prn_other'] })) as string)).toEqual({
      agents: finalRows,
    });
  });

  it('rejects an unknown status', async () => {
    const { db } = makeDb([[{ id: 'ins_caller' }]]);
    await expect(handler(db)({ status: 'banana' })).rejects.toThrow(/status must be one of/);
  });

  it('rejects an empty principals array', async () => {
    const { db } = makeDb([[]]);
    await expect(handler(db)({ principals: [] })).rejects.toThrow(/non-empty/);
  });
});
