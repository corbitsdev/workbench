// Hub-side workflow authorizer, exercised against the REAL `@intx/authz`
// `evaluateGrants` and the `tool:<name>`/`invoke` grammar `buildToolGrantRows`
// persists. Grants are sourced via `createGrantStore.collectGrants`, which we
// drive from a stubbed `collectGrants` returning the persisted rows for the run
// principal — the same rows the orchestrator reconnect reads from the DB.

import { describe, expect, mock, test } from 'bun:test';
import type { GrantRule } from '@intx/authz';
import type { RunState } from './executor';

// Override only createGrantStore on @intx/db; preserve the rest so sibling
// suites keep theirs. The store returns the persisted grants for a principal.
const realDb = await import('@intx/db');
const grantsByPrincipal = new Map<string, GrantRule[]>();
let collectCalls = 0;
mock.module('@intx/db', () => ({
  ...realDb,
  createGrantStore: () => ({
    collectGrants: async (principalId: string, _tenantId: string) => {
      collectCalls += 1;
      return grantsByPrincipal.get(principalId) ?? [];
    },
  }),
}));

const { createWorkflowAuthorizer } = await import('./authz');

function grant(resource: string): GrantRule {
  return {
    id: `grt_${resource}`,
    resource,
    action: 'invoke',
    effect: 'allow',
    origin: 'system',
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

function runState(principalId: string): RunState {
  return {
    runId: 'wfr_1',
    kind: 'k',
    tenantId: 'tn-1',
    principalId,
    status: 'running',
    currentStepId: null,
    input: {},
    outputs: {},
  };
}

const db = {} as unknown as Parameters<typeof createWorkflowAuthorizer>[0]['db'];

describe('createWorkflowAuthorizer (real @intx/authz)', () => {
  test('assertToolGranted allows a granted tool and rejects an ungranted one', async () => {
    grantsByPrincipal.set('prn-granted', [grant('tool:granola_get_note')]);
    const authz = createWorkflowAuthorizer({ db });
    const state = runState('prn-granted');

    // granted tool: resolves
    await authz.assertToolGranted(state, 'granola_get_note');

    // ungranted tool: throws, naming the resource
    await expect(authz.assertToolGranted(state, 'gamma_generate')).rejects.toThrow(
      /tool:gamma_generate\/invoke/
    );
  });

  test('assertToolGranted denies every tool when the principal has no grants', async () => {
    grantsByPrincipal.set('prn-empty', []);
    const authz = createWorkflowAuthorizer({ db });
    await expect(
      authz.assertToolGranted(runState('prn-empty'), 'granola_get_note')
    ).rejects.toThrow(/not granted/);
  });

  test('authorizeFn is grant-backed: allow for granted, deny otherwise', async () => {
    grantsByPrincipal.set('prn-inf', [grant('tool:analyze')]);
    const authz = createWorkflowAuthorizer({ db });
    const fn = authz.authorizeFn(runState('prn-inf'));

    const allowed = await fn('tool:analyze', 'invoke');
    expect(allowed.effect).toBe('allow');

    const denied = await fn('tool:other', 'invoke');
    expect(denied.effect).not.toBe('allow');
  });

  test('grants are cached per principal+tenant for the run lifetime', async () => {
    grantsByPrincipal.set('prn-cache', [grant('tool:a'), grant('tool:b')]);
    const authz = createWorkflowAuthorizer({ db });
    const state = runState('prn-cache');
    const before = collectCalls;

    await authz.assertToolGranted(state, 'a');
    await authz.assertToolGranted(state, 'b');
    await authz.authorizeFn(state)('tool:a', 'invoke');

    // collectGrants resolved exactly once for this principal+tenant.
    expect(collectCalls - before).toBe(1);
  });
});
