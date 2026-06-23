// The hub tool runner must gate every invoke through the workflow authorizer
// BEFORE touching the tool registry — the same gate the native sidecar step
// path enforces. An ungranted tool must be rejected without invoking it.

import { describe, expect, mock, test } from 'bun:test';
import type { RunState } from './executor';

// Stub the tool registry so a "granted" tool resolves to a known credential
// tool we can observe being invoked, and so the unknown-tool branch is not hit
// for our granted name. runCredentialTool is stubbed to record invocations.
// Stub ONLY the credential-tool invoker so we can observe whether the gate
// short-circuits before invoke. The real tool registry stays intact (mocking
// it process-globally would leak into sibling suites), so the test uses real
// credential-tool names from KNOWN_TOOLS.
const realCredTool = await import('../lib/run-credential-tool');
const invoked: string[] = [];
mock.module('../lib/run-credential-tool', () => ({
  ...realCredTool,
  runCredentialTool: async (_db: unknown, _tenant: string, tool: string) => {
    invoked.push(tool);
    return JSON.stringify({ ok: tool });
  },
}));

const { createHubToolRunner } = await import('./hub-runners');
const { isCredentialToolEntry, KNOWN_TOOLS } = await import('../lib/tool-registry');

// Two real credential tools from the registry: one the fake authorizer grants,
// one it does not.
const credentialTools = Object.keys(KNOWN_TOOLS).filter((n) =>
  isCredentialToolEntry(KNOWN_TOOLS[n]!)
);
const GRANTED = credentialTools[0]!;
const UNGRANTED = credentialTools[1]!;

function state(principalId: string): RunState {
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

// A fake authorizer: only GRANTED is granted.
const authorizer = {
  assertToolGranted: async (_s: RunState, tool: string) => {
    if (tool !== GRANTED) {
      throw new Error(`workflow executor: principal not granted tool:${tool}/invoke`);
    }
  },
  authorizeFn: () => async () => ({
    effect: 'allow' as const,
    matchingGrants: [],
    resolvedBy: null,
  }),
};

const db = {} as Parameters<typeof createHubToolRunner>[0]['db'];

describe('createHubToolRunner tool-grant gate', () => {
  test('dispatches canonical package tool names through the local hub registry name', async () => {
    invoked.length = 0;
    const canonical = '@workbench/tools-granola/granola:granola_list_notes';
    const runner = createHubToolRunner({
      db,
      authorizer: {
        assertToolGranted: async (_s: RunState, tool: string) => {
          if (tool !== canonical) {
            throw new Error(`workflow executor: principal not granted tool:${tool}/invoke`);
          }
        },
        authorizeFn: () => async () => ({
          effect: 'allow' as const,
          matchingGrants: [],
          resolvedBy: null,
        }),
      },
    });

    const result = await runner.run({
      tool: canonical,
      input: {},
      state: state('prn-1'),
    });

    expect(invoked).toEqual(['granola_list_notes']);
    expect(result).toEqual({ content: JSON.stringify({ ok: 'granola_list_notes' }) });
  });

  test('rejects an ungranted tool without invoking it', async () => {
    invoked.length = 0;
    const runner = createHubToolRunner({ db, authorizer });
    await expect(runner.run({ tool: UNGRANTED, input: {}, state: state('prn-1') })).rejects.toThrow(
      /not granted/
    );
    expect(invoked).toEqual([]);
  });

  test('invokes a granted tool', async () => {
    invoked.length = 0;
    const runner = createHubToolRunner({ db, authorizer });
    const result = await runner.run({
      tool: GRANTED,
      input: {},
      state: state('prn-1'),
    });
    expect(invoked).toEqual([GRANTED]);
    expect(result).toEqual({ content: JSON.stringify({ ok: GRANTED }) });
  });
});
