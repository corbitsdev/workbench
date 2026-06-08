import { describe, expect, it } from 'bun:test';
import type { InstanceEvent } from '@intx/hub-client';
import { convertInstanceEvents } from './adapter';

describe('convertInstanceEvents', () => {
  it('converts a mail event with role user to a ChatMessage', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'mail',
        id: 'msg-1',
        role: 'user',
        content: 'Hello Myra',
        sender: { name: 'Alice', email: 'alice@example.com' },
        recipients: [{ name: 'Myra', email: 'myra@workbench.example' }],
        timestamp: '2024-01-01T00:00:00.000Z',
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.id).toBe('msg-1');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello Myra');
    expect(msg.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('converts a mail event with role assistant to a ChatMessage with agent role', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'mail',
        id: 'msg-2',
        role: 'assistant',
        content: 'Hello, how can I help?',
        sender: { name: 'Myra', email: 'myra@workbench.example' },
        recipients: [{ name: 'Alice', email: 'alice@example.com' }],
        timestamp: '2024-01-01T00:01:00.000Z',
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.role).toBe('agent');
  });

  it('converts a turn event to a ChatMessage with agent role', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'turn',
        turnId: 'turn-1',
        content: 'Processing your request.',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.id).toBe('turn-1');
    expect(msg.role).toBe('agent');
    expect(msg.content).toBe('Processing your request.');
    expect(msg.createdAt).toBe('2024-01-01T00:02:00.000Z');
  });

  it('marks mail events with isError as failed', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'mail',
        id: 'msg-3',
        role: 'assistant',
        content: 'Error occurred',
        sender: { name: 'Myra', email: 'myra@workbench.example' },
        recipients: [],
        timestamp: '2024-01-01T00:03:00.000Z',
        attachments: [],
        isError: true,
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages[0]?.status).toBe('failed');
  });

  it('marks turn events with isError as failed', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'turn',
        turnId: 'turn-2',
        content: 'Inference failed',
        timestamp: '2024-01-01T00:04:00.000Z',
        isError: true,
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages[0]?.status).toBe('failed');
  });

  it('converts multiple events preserving order', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'mail',
        id: 'a',
        role: 'user',
        content: 'First',
        sender: { name: null, email: 'u@example.com' },
        recipients: [],
        timestamp: '2024-01-01T00:00:00.000Z',
        attachments: [],
      },
      {
        kind: 'turn',
        turnId: 'b',
        content: 'Second',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe('a');
    expect(messages[1]?.id).toBe('b');
  });

  it('preserves input order — sorting is the hub-client session responsibility', () => {
    // The hub-client sorts events during hydration. convertInstanceEvents
    // intentionally preserves insertion order so that live SSE turn events
    // (which carry client-side timestamps) are not reordered relative to
    // concurrently-received user mails with server-side timestamps.
    const events: InstanceEvent[] = [
      {
        kind: 'turn',
        turnId: 'turn-2',
        content: 'Second',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
      {
        kind: 'mail',
        id: 'msg-1',
        role: 'user',
        content: 'First',
        sender: { name: null, email: 'u@example.com' },
        recipients: [],
        timestamp: '2024-01-01T00:00:00.000Z',
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(2);
    // Input order preserved — turn-2 was first in the array
    expect(messages[0]?.id).toBe('turn-2');
    expect(messages[1]?.id).toBe('msg-1');
  });

  it('returns empty array for empty input', () => {
    expect(convertInstanceEvents([])).toEqual([]);
  });

  it('strips leading <context> block from user mail content', () => {
    const events: InstanceEvent[] = [
      {
        kind: 'mail',
        id: 'mail-1',
        role: 'user',
        content: '<context>\nDate: 5/6/2026\nHuman Operator: Sawyer\n</context>\n\nHello Myra',
        sender: { name: 'Sawyer', email: 'sawyer@example.com' },
        recipients: [{ name: 'Myra', email: 'myra@workbench.example' }],
        attachments: [],
        timestamp: '2026-06-05T00:00:00Z',
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.content).toBe('Hello Myra');
  });
});
