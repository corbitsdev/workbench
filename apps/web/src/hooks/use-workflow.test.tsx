/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useStepOutput,
  useWorkflowRuns,
  useMyRuns,
  useDeleteRun,
  useAllStepOutputs,
  isTerminalPhase,
} from './use-workflow';

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('useStepOutput', () => {
  it('is disabled when deploymentId or stepId is null', () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, { stepId: 's', output: 1 }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStepOutput(null, 'step-a'), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(called).toBe(false);
  });

  it('is disabled when opts.enabled is false even with ids present', () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, { stepId: 's', output: 1 }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStepOutput('dep-1', 'step-a', { enabled: false }), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(called).toBe(false);
  });

  it('returns the parsed output when enabled and the step is completed', async () => {
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toContain('/workflow-runs/dep-1/steps/step-a/output');
      return Promise.resolve(jsonResponse(200, { stepId: 'step-a', output: { headline: 'hi' } }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStepOutput('dep-1', 'step-a'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ headline: 'hi' });
  });

  it('surfaces an error for a malformed response shape', async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, { wrong: true }))) as typeof fetch;

    const { result } = renderHook(() => useStepOutput('dep-1', 'step-a'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('includes the active tenantId in the step-output request when provided', async () => {
    let requested = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, { stepId: 'step-a', output: 1 }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStepOutput('dep-1', 'step-a', { tenantId: 'tn-wb' }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain('tenantId=tn-wb');
  });
});

describe('isTerminalPhase', () => {
  it('returns true for completed, failed, cancelled', () => {
    expect(isTerminalPhase('completed')).toBe(true);
    expect(isTerminalPhase('failed')).toBe(true);
    expect(isTerminalPhase('cancelled')).toBe(true);
  });

  it('returns false for running and pending', () => {
    expect(isTerminalPhase('running')).toBe(false);
    expect(isTerminalPhase('pending')).toBe(false);
  });
});

describe('useAllStepOutputs', () => {
  it('is disabled when deploymentId is null', () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, { outputs: {} }));
    }) as typeof fetch;

    const { result } = renderHook(() => useAllStepOutputs(null, null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(called).toBe(false);
  });

  it('hits the /steps endpoint and returns the outputs map when enabled', async () => {
    let requested = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(
        jsonResponse(200, { outputs: { 'step-a': { x: 1 }, 'step-b': 'done' } })
      );
    }) as typeof fetch;

    const { result } = renderHook(() => useAllStepOutputs('dep-1', 'tn-x'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain('/workflow-runs/dep-1/steps');
    expect(requested).toContain('tenantId=tn-x');
    expect(result.current.data).toEqual({ 'step-a': { x: 1 }, 'step-b': 'done' });
  });

  it('throws on a malformed response', async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, { wrong: true }))) as typeof fetch;

    const { result } = renderHook(() => useAllStepOutputs('dep-1', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useMyRuns', () => {
  it('hits /workflow-runs/mine and parses one row per run, admitting a null runId', async () => {
    let requested = '';
    const rows = [
      {
        runId: null,
        correlationMessageId: 'msg-1',
        deploymentId: 'dep-1',
        kind: 'collateral-generation',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        runId: 'run-2',
        correlationMessageId: 'msg-2',
        deploymentId: 'dep-2',
        kind: 'presentation-generation',
        status: 'completed',
        startedAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, rows));
    }) as typeof fetch;

    const { result } = renderHook(() => useMyRuns('tn-wb'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain('/workflow-runs/mine');
    expect(requested).toContain('tenantId=tn-wb');
    expect(result.current.data).toEqual(rows);
  });

  it('throws on a malformed /workflow-runs/mine row', async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, [{ correlationMessageId: 'msg-1' }]))) as typeof fetch;

    const { result } = renderHook(() => useMyRuns('tn-wb'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useDeleteRun', () => {
  it('issues a DELETE to /workflow-runs/instances/:runId — NOT the deployment endpoint', async () => {
    let requested = '';
    let method = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requested = String(url);
      method = init?.method ?? 'GET';
      return Promise.resolve(jsonResponse(204, {}));
    }) as typeof fetch;

    const { result } = renderHook(() => useDeleteRun('tn-wb'), { wrapper: wrapper() });
    await result.current.mutateAsync('run-abc');

    expect(method).toBe('DELETE');
    expect(requested).toContain('/workflow-runs/instances/run-abc');
    expect(requested).not.toContain('/workflows/');
    expect(requested).toContain('tenantId=tn-wb');
  });

  it('url-encodes the runId in the delete path', async () => {
    let requested = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(204, {}));
    }) as typeof fetch;

    const { result } = renderHook(() => useDeleteRun(), { wrapper: wrapper() });
    await result.current.mutateAsync('run/with space');

    expect(requested).toContain('/workflow-runs/instances/run%2Fwith%20space');
  });
});

describe('useWorkflowRuns', () => {
  it('omits tenantId from the request when no workbench is active', async () => {
    let requested = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, []));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRuns(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain('/workflow-runs');
    expect(requested).not.toContain('tenantId=');
  });

  it('includes the active workbench tenantId when one is active', async () => {
    let requested = '';
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, []));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRuns('tn-wb'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain('tenantId=tn-wb');
  });
});
