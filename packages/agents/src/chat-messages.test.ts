import { describe, expect, it } from 'bun:test';
import type { InstanceEvent } from '@intx/hub-client';
import { composeChatMessages, EMPTY_RETAINED, type RetainedAgentText } from './chat-messages';

const userMail = (id: string, content: string): InstanceEvent => ({
  kind: 'mail',
  id,
  role: 'user',
  content,
  sender: { name: null, email: 'u@example.com' },
  recipients: [],
  timestamp: '2024-01-01T00:00:00.000Z',
  attachments: [],
});

const assistantMail = (id: string, content: string): InstanceEvent => ({
  kind: 'mail',
  id,
  role: 'assistant',
  content,
  sender: { name: 'Agent', email: 'a@example.com' },
  recipients: [],
  timestamp: '2024-01-01T00:01:00.000Z',
  attachments: [],
});

const emptyTurn = (turnId: string): InstanceEvent => ({
  kind: 'turn',
  turnId,
  content: '',
  timestamp: '2024-01-01T00:00:30.000Z',
});

describe('composeChatMessages', () => {
  it('appends a live streaming bubble while streaming', () => {
    const { messages, retained } = composeChatMessages({
      events: [userMail('u1', 'hi')],
      streaming: 'Thinking out lou',
    });
    const last = messages[messages.length - 1];
    expect(last?.id).toBe('streaming');
    expect(last?.content).toBe('Thinking out lou');
    expect(last?.status).toBe('sending');
    expect(retained).toEqual({ text: 'Thinking out lou', afterUserId: 'u1' });
  });

  it('retains the streamed text after streaming clears but before a durable reply', () => {
    // The turn committed empty (CL-1398) and no assistant mail has arrived yet.
    const { messages, retained } = composeChatMessages({
      events: [userMail('u1', 'hi'), emptyTurn('t1')],
      streaming: '',
      retained: { text: 'Here is my answer', afterUserId: 'u1' },
    });
    const last = messages[messages.length - 1];
    expect(last?.content).toBe('Here is my answer');
    expect(last?.status).toBeUndefined();
    expect(retained.text).toBe('Here is my answer');
  });

  it('drops the retained text once a durable assistant reply lands', () => {
    const { messages, retained } = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'Here is my answer')],
      streaming: '',
      retained: { text: 'Here is my answer', afterUserId: 'u1' },
    });
    expect(messages.some((m) => m.id === 'streaming')).toBe(false);
    expect(messages[messages.length - 1]?.content).toBe('Here is my answer');
    expect(retained).toEqual(EMPTY_RETAINED);
  });

  it('suppresses a stale streaming buffer once a durable reply has landed', () => {
    // Interchange fails to clear its streaming buffer across multi-reply
    // sessions (session.ts only clears when `streaming === text`), so deltas
    // from a later reply append onto leftover text. Even with a non-empty
    // streaming buffer, once a durable assistant reply exists for the last user
    // message we must not render the buffer — it duplicates/concatenates.
    const { messages, retained } = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'Real answer')],
      streaming: 'greeting onegreeting two',
    });
    expect(messages.some((m) => m.id === 'streaming')).toBe(false);
    expect(messages[messages.length - 1]?.content).toBe('Real answer');
    expect(retained).toEqual(EMPTY_RETAINED);
  });

  it('drops stale retained text when a new user message arrives', () => {
    const { messages, retained } = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'first answer'), userMail('u2', 'again')],
      streaming: '',
      retained: { text: 'first answer', afterUserId: 'u1' },
    });
    expect(messages.some((m) => m.id === 'streaming')).toBe(false);
    expect(retained).toEqual(EMPTY_RETAINED);
  });

  it('treats a tool-call-only turn as a durable reply', () => {
    const toolTurn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: '',
      timestamp: '2024-01-01T00:00:30.000Z',
      toolCalls: [{ name: 'exa_search', arguments: { query: 'x' }, result: 'r', isError: false }],
    };
    const { retained } = composeChatMessages({
      events: [userMail('u1', 'search'), toolTurn],
      streaming: '',
      retained: { text: 'leftover', afterUserId: 'u1' },
    });
    expect(retained).toEqual(EMPTY_RETAINED);
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

  it('returns EMPTY_RETAINED when idle with no retained text', () => {
    const retained: RetainedAgentText = EMPTY_RETAINED;
    const result = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'done')],
      streaming: '',
      retained,
    });
    expect(result.retained).toEqual(EMPTY_RETAINED);
    expect(result.messages.some((m) => m.id === 'streaming')).toBe(false);
  });
});
