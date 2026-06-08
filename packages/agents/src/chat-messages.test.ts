import { describe, expect, it } from 'bun:test';
import type { InstanceEvent } from '@intx/hub-client';
import { composeChatMessages } from './chat-messages';

const userMail = (
  id: string,
  content: string,
  timestamp = '2024-01-01T00:00:00.000Z'
): InstanceEvent => ({
  kind: 'mail',
  id,
  role: 'user',
  content,
  sender: { name: null, email: 'u@example.com' },
  recipients: [],
  timestamp,
  attachments: [],
});

const assistantMail = (
  id: string,
  content: string,
  timestamp = '2024-01-01T00:01:00.000Z'
): InstanceEvent => ({
  kind: 'mail',
  id,
  role: 'assistant',
  content,
  sender: { name: 'Agent', email: 'a@example.com' },
  recipients: [],
  timestamp,
  attachments: [],
});

describe('composeChatMessages', () => {
  it('synthesizes a streaming bubble while streaming with no durable reply yet', () => {
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'hi')],
      streaming: 'Thinking out lou',
    });
    const last = messages[messages.length - 1];
    expect(last?.id).toBe('streaming-synthetic');
    expect(last?.content).toBe('Thinking out lou');
    expect(last?.status).toBe('sending');
  });

  it('overwrites the trailing assistant bubble with the live streaming buffer', () => {
    // turn.committed landed empty (CL-1398) but the streamed text is still live.
    const emptyTurn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: '',
      timestamp: '2024-01-01T00:00:30.000Z',
    };
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'hi'), emptyTurn],
      streaming: 'Here is my answer',
    });
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('agent');
    expect(last?.content).toBe('Here is my answer');
    expect(last?.status).toBe('sending');
  });

  it('shows no streaming bubble once the durable reply has landed and streaming cleared', () => {
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'Real answer')],
      streaming: '',
    });
    expect(messages.some((m) => m.id === 'streaming-synthetic')).toBe(false);
    expect(messages[messages.length - 1]?.content).toBe('Real answer');
  });

  it('sorts the final list by timestamp regardless of event order', () => {
    // Events supplied out of chronological order; expect them re-sorted.
    const { messages } = composeChatMessages({
      events: [
        assistantMail('a1', 'second', '2024-01-01T00:02:00.000Z'),
        userMail('u1', 'first', '2024-01-01T00:01:00.000Z'),
      ],
      streaming: '',
    });
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('deduplicates an assistant mail that echoes a committed turn', () => {
    const turn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: 'Same content',
      timestamp: '2024-01-01T00:00:30.000Z',
    };
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'hi'), turn, assistantMail('a1', 'Same content')],
      streaming: '',
    });
    const agentMessages = messages.filter(
      (m) => m.role === 'agent' && m.content === 'Same content'
    );
    expect(agentMessages).toHaveLength(1);
  });

  it('renders tool-call turns', () => {
    const toolTurn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: '',
      timestamp: '2024-01-01T00:00:30.000Z',
      toolCalls: [{ name: 'exa_search', arguments: { query: 'x' }, result: 'r', isError: false }],
    };
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'search'), toolTurn],
      streaming: '',
    });
    const turnMsg = messages.find((m) => m.id === 't1');
    expect(turnMsg?.toolCalls?.[0]?.name).toBe('exa_search');
  });
});
