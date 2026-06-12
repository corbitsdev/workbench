/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { createImageTracker } from './image-tracker';
import type { Transport } from '@intx/hub-client';

function createRecordingTransport(): { transport: Transport; push: (event: unknown) => void } {
  let listener: ((event: unknown) => void) | null = null;
  const transport: Transport = {
    fetch: async () => {
      throw new Error('not implemented');
    },
    subscribe(_path, onEvent) {
      listener = onEvent;
      return () => {
        listener = null;
      };
    },
  };
  return {
    transport,
    push: (event) => listener?.(event),
  };
}

describe('createImageTracker', () => {
  it('starts with an empty images list', () => {
    const { transport } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });
    expect(tracker.images).toEqual([]);
    tracker.stop();
  });

  it('captures a base64 image from an inference.image_output event', () => {
    const { transport, push } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });

    push({
      type: 'inference.image_output',
      data: {
        image: { type: 'image', source: { kind: 'base64', mimeType: 'image/png', data: 'abc123' } },
      },
    });

    expect(tracker.images).toEqual([{ mimeType: 'image/png', data: 'abc123' }]);
    tracker.stop();
  });

  it('accumulates multiple images within a turn', () => {
    const { transport, push } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });

    push({
      type: 'inference.image_output',
      data: {
        image: { type: 'image', source: { kind: 'base64', mimeType: 'image/png', data: 'img1' } },
      },
    });
    push({
      type: 'inference.image_output',
      data: {
        image: { type: 'image', source: { kind: 'base64', mimeType: 'image/jpeg', data: 'img2' } },
      },
    });

    expect(tracker.images.length).toBe(2);
    tracker.stop();
  });

  it('clears images on turn.committed', () => {
    const { transport, push } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });

    push({
      type: 'inference.image_output',
      data: {
        image: { type: 'image', source: { kind: 'base64', mimeType: 'image/png', data: 'abc123' } },
      },
    });
    push({ type: 'turn.committed' });

    expect(tracker.images).toEqual([]);
    tracker.stop();
  });

  it('calls onUpdate when an image is received', () => {
    const { transport, push } = createRecordingTransport();
    let calls = 0;
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' }, () => {
      calls++;
    });

    push({
      type: 'inference.image_output',
      data: {
        image: { type: 'image', source: { kind: 'base64', mimeType: 'image/png', data: 'x' } },
      },
    });

    expect(calls).toBe(1);
    tracker.stop();
  });

  it('ignores non-base64 image sources', () => {
    const { transport, push } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });

    push({
      type: 'inference.image_output',
      data: {
        image: {
          type: 'image',
          source: { kind: 'url', mimeType: 'image/png', url: 'https://example.com/img.png' },
        },
      },
    });

    expect(tracker.images).toEqual([]);
    tracker.stop();
  });

  it('ignores malformed events', () => {
    const { transport, push } = createRecordingTransport();
    const tracker = createImageTracker(transport, { tenantId: 't1', instanceId: 'i1' });

    push(null);
    push({ type: 'inference.image_output' });
    push({ type: 'inference.image_output', data: {} });

    expect(tracker.images).toEqual([]);
    tracker.stop();
  });
});
