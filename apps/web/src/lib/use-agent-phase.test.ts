/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';

type Listener = (event: unknown) => void;

// Controllable fake transport keyed by path; multiple subscribers per path are
// fanned out, mirroring the real shared event stream.
const channels = new Map<string, Set<Listener>>();

mock.module('./instance-transport', () => ({
  createHubTransport: () => ({
    fetch: async () => undefined,
    subscribe(path: string, onEvent: Listener) {
      const listeners = channels.get(path) ?? new Set<Listener>();
      listeners.add(onEvent);
      channels.set(path, listeners);
      return () => {
        listeners.delete(onEvent);
        if (listeners.size === 0) channels.delete(path);
      };
    },
  }),
}));

function emit(instanceId: string, event: unknown): void {
  const path = `/api/tenants/tenant_1/agents/instances/${instanceId}/events`;
  const listeners = channels.get(path);
  if (listeners) for (const listener of listeners) listener(event);
}

const { useAgentPhase } = await import('./use-agent-phase');

const target = { instanceId: 'inst_a', tenantId: 'tenant_1' };

afterEach(() => {
  channels.clear();
});

describe('useAgentPhase', () => {
  it('returns null and opens no subscription when there is no agent to track', () => {
    const { result } = renderHook(() => useAgentPhase(null));
    expect(result.current).toBeNull();
    expect(channels.size).toBe(0);
  });

  it('reports idle for a running agent with no live stream', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    expect(result.current).toBe('idle');
  });

  it('reports thinking while the agent streams reasoning', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit('inst_a', {
        type: 'inference.thinking.delta',
        data: { partial: { thinking: 'weighing options' } },
      });
    });
    expect(result.current).toBe('thinking');
  });

  it('reports thinking during a tool call (active, no streamed text)', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit('inst_a', { type: 'inference.start' });
    });
    expect(result.current).toBe('thinking');
  });

  it('reports typing once visible answer text streams', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit('inst_a', { type: 'inference.text.delta', data: { partial: { text: 'Here' } } });
    });
    expect(result.current).toBe('typing');
  });

  it('returns to idle when the turn commits', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit('inst_a', { type: 'inference.text.delta', data: { partial: { text: 'Here' } } });
    });
    expect(result.current).toBe('typing');
    act(() => {
      emit('inst_a', { type: 'turn.committed' });
    });
    expect(result.current).toBe('idle');
  });

  it('recovers to idle when a turn fails mid-reasoning', () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit('inst_a', { type: 'inference.start' });
      emit('inst_a', {
        type: 'inference.thinking.delta',
        data: { partial: { thinking: 'working' } },
      });
    });
    expect(result.current).toBe('thinking');
    act(() => {
      emit('inst_a', { type: 'reactor.error' });
    });
    expect(result.current).toBe('idle');
  });

  it('tears down its subscription on unmount', () => {
    const { unmount } = renderHook(() => useAgentPhase(target));
    expect(channels.size).toBe(1);
    unmount();
    expect(channels.size).toBe(0);
  });

  it('tracks two agents independently without disturbing each other', () => {
    const a = renderHook(() => useAgentPhase(target));
    const b = renderHook(() => useAgentPhase({ instanceId: 'inst_b', tenantId: 'tenant_1' }));

    act(() => {
      emit('inst_b', { type: 'inference.text.delta', data: { partial: { text: 'reply' } } });
    });

    expect(a.result.current).toBe('idle');
    expect(b.result.current).toBe('typing');

    // Unmounting one leaves the other's subscription intact.
    a.unmount();
    expect(channels.has('/api/tenants/tenant_1/agents/instances/inst_b/events')).toBe(true);
  });
});
