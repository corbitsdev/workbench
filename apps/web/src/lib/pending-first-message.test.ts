/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { setPendingFirstMessage, takePendingFirstMessage } from './pending-first-message';

describe('pending-first-message', () => {
  it('returns the seeded message for a thread', () => {
    setPendingFirstMessage('thr-a', 'hello world');
    expect(takePendingFirstMessage('thr-a')).toBe('hello world');
  });

  it('delivers a message exactly once (delete-on-read)', () => {
    setPendingFirstMessage('thr-b', 'only once');
    expect(takePendingFirstMessage('thr-b')).toBe('only once');
    // A second surface racing for the same thread gets nothing — no double-send.
    expect(takePendingFirstMessage('thr-b')).toBeNull();
  });

  it('returns null for a thread with no pending message', () => {
    expect(takePendingFirstMessage('never-set')).toBeNull();
  });

  it('keys messages independently per thread', () => {
    setPendingFirstMessage('thr-c', 'c-msg');
    setPendingFirstMessage('thr-d', 'd-msg');
    expect(takePendingFirstMessage('thr-d')).toBe('d-msg');
    expect(takePendingFirstMessage('thr-c')).toBe('c-msg');
  });

  it('overwrites an undelivered message for the same thread', () => {
    setPendingFirstMessage('thr-e', 'first');
    setPendingFirstMessage('thr-e', 'second');
    expect(takePendingFirstMessage('thr-e')).toBe('second');
  });
});
