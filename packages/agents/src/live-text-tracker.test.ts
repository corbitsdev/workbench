import { describe, expect, it } from 'bun:test';
import type { Transport } from '@intx/hub-client';
import { createLiveTextTracker } from './live-text-tracker';

function createFakeTransport(): {
  transport: Transport;
  emit: (event: unknown) => void;
  stopped: () => boolean;
} {
  let handler: ((event: unknown) => void) | null = null;
  let stopped = false;
  const transport: Transport = {
    fetch: async () => {
      throw new Error('not used');
    },
    subscribe: (_path, onEvent) => {
      handler = onEvent;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    transport,
    emit: (event) => handler?.(event),
    stopped: () => stopped,
  };
}

const params = { tenantId: 't1', instanceId: 'i1' };

const delta = (text: string) => ({
  type: 'inference.text.delta',
  data: { partial: { text } },
});

const turnCommitted = () => ({ type: 'turn.committed', data: { turnId: 'x', text: '' } });

describe('createLiveTextTracker', () => {
  it('mirrors the current turn cumulative partial text', () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit(delta('Hel'));
    emit(delta('Hello'));
    emit(delta('Hello there'));

    expect(tracker.text).toBe('Hello there');
  });

  it('clears on turn.committed so the durable bubble is not duplicated', () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit(delta('first answer'));
    expect(tracker.text).toBe('first answer');

    emit(turnCommitted());
    expect(tracker.text).toBe('');
  });

  it('does not accumulate across turns — a new turn replaces, never appends', () => {
    // The core CL-1643 bug: the session buffer held [first answer][second
    // answer]. partial.text is per-turn, so the second turn's deltas carry only
    // the second turn's text and the tracker never merges them.
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit(delta('first answer'));
    emit(turnCommitted());
    emit(delta('second'));
    emit(delta('second answer'));

    expect(tracker.text).toBe('second answer');
  });

  it('seeds from a replay event for a subscriber that joined mid-turn', () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit({ type: 'inference.text.replay', data: { turnId: 't', text: 'already streaming' } });
    expect(tracker.text).toBe('already streaming');
  });

  it('lets live deltas win over a stale replay once they arrive', () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit(delta('live text'));
    // A replay arriving after live deltas must not clobber the live text.
    emit({ type: 'inference.text.replay', data: { turnId: 't', text: 'stale' } });
    expect(tracker.text).toBe('live text');
  });

  it('ignores unrelated events', () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    emit(delta('hi'));
    emit({ type: 'inference.tool_call.start', data: { callId: 'c1', name: 'search' } });
    emit({ type: 'mail.delivered', data: { id: 'm1' } });

    expect(tracker.text).toBe('hi');
  });

  it('stops the underlying subscription', () => {
    const { transport, stopped } = createFakeTransport();
    const tracker = createLiveTextTracker(transport, params);

    tracker.stop();
    expect(stopped()).toBe(true);
  });
});
