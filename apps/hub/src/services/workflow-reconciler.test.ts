import { describe, expect, it, mock } from 'bun:test';
import type { SidecarRouter } from '@intx/hub-sessions';
import type { HubDb } from '../db';
import type { EnsureDeploymentRoutableFn } from '../routes/workflow-runs';
import { createWorkflowReconciler } from './workflow-reconciler';

type Row = {
  deploymentId: string | null;
  kind: string;
  tenantId: string;
  principalId: string;
};

// db whose select(...).from(...).where(...) resolves to the given active rows —
// matching the reconciler's query shape (no orderBy).
function makeDb(rows: Row[]): HubDb {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as HubDb;
}

// events stub capturing the agent.reconnected handler so the test can fire it.
function makeEvents() {
  let handler: (() => void) | undefined;
  const events = {
    on: mock((_type: string, fn: () => void) => {
      handler = fn;
      return () => {};
    }),
  } as unknown as SidecarRouter['events'];
  return {
    events,
    fireReconnect() {
      if (handler === undefined) throw new Error('no agent.reconnected handler registered');
      handler();
    },
  };
}

describe('createWorkflowReconciler', () => {
  it('re-establishes every active deployment, skipping rows without a deploymentId', async () => {
    const calls: Array<{ deploymentId: string; kind: string; tenantId: string }> = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      calls.push({ deploymentId: args.deploymentId, kind: args.kind, tenantId: args.tenantId });
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb([
        { deploymentId: 'ses_a', kind: 'pain-point-collateral', tenantId: 't1', principalId: 'p1' },
        { deploymentId: null, kind: 'orphan', tenantId: 't1', principalId: 'p1' },
        { deploymentId: 'ses_b', kind: 'deck', tenantId: 't2', principalId: 'p2' },
      ]),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual([
      { deploymentId: 'ses_a', kind: 'pain-point-collateral', tenantId: 't1' },
      { deploymentId: 'ses_b', kind: 'deck', tenantId: 't2' },
    ]);
  });

  it('is best-effort: one deployment failing does not abort the pass', async () => {
    const seen: string[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      seen.push(args.deploymentId);
      if (args.deploymentId === 'ses_a') return Promise.reject(new Error('boom'));
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb([
        { deploymentId: 'ses_a', kind: 'k', tenantId: 't', principalId: 'p' },
        { deploymentId: 'ses_b', kind: 'k', tenantId: 't', principalId: 'p' },
      ]),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
    });

    await reconciler.reconcileAll();

    expect(seen).toEqual(['ses_a', 'ses_b']);
  });

  it('reconciles on agent.reconnected, coalescing concurrent triggers into one pass', async () => {
    let resolveEnsure: (() => void) | undefined;
    let ensureCalls = 0;
    const ensure: EnsureDeploymentRoutableFn = () => {
      ensureCalls += 1;
      return new Promise((resolve) => {
        resolveEnsure = () => resolve({ reestablished: true });
      });
    };
    const evt = makeEvents();
    const reconciler = createWorkflowReconciler({
      db: makeDb([{ deploymentId: 'ses_a', kind: 'k', tenantId: 't', principalId: 'p' }]),
      events: evt.events,
      ensureDeploymentRoutable: ensure,
    });

    reconciler.start();

    // Two reconnect events while the first pass is still in flight must not
    // start a second pass — the in-flight pass already covers the deployment.
    evt.fireReconnect();
    evt.fireReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureCalls).toBe(1);
    resolveEnsure?.();
  });

  it('start() subscribes to agent.reconnected', () => {
    const evt = makeEvents();
    const reconciler = createWorkflowReconciler({
      db: makeDb([]),
      events: evt.events,
      ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
    });
    reconciler.start();
    expect(evt.events.on).toHaveBeenCalledWith('agent.reconnected', expect.any(Function));
  });
});
