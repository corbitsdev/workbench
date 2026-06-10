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

  it('does not overwrite a non-empty committed bubble — the next segment streams as its own bubble', () => {
    // Multi-step tool-loop reply: an earlier text segment commits as its own
    // (non-empty) bubble, then the next segment's text streams live. Overwriting
    // the committed segment would transiently mask it (CL-1643). The live text
    // belongs to a not-yet-committed turn, so it must form a new bubble.
    const committedSegment: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: 'Let me search for that.',
      timestamp: '2024-01-01T00:00:30.000Z',
      toolCalls: [{ name: 'exa_search', arguments: { query: 'x' }, result: 'r', isError: false }],
    };
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'find x'), committedSegment],
      streaming: 'Here is what I found',
    });
    const agentMessages = messages.filter((m) => m.role === 'agent');
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[0]?.content).toBe('Let me search for that.');
    expect(agentMessages[1]?.content).toBe('Here is what I found');
    expect(agentMessages[1]?.status).toBe('sending');
  });

  it('shows no streaming bubble once the durable reply has landed and streaming cleared', () => {
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'hi'), assistantMail('a1', 'Real answer')],
      streaming: '',
    });
    expect(messages.some((m) => m.id === 'streaming-synthetic')).toBe(false);
    expect(messages[messages.length - 1]?.content).toBe('Real answer');
  });

  it('keeps the server-timestamped mail and drops the echoing text-only turn', () => {
    // A text reply exists as both a client-clock turn and a server-clock mail.
    // The mail must win so ordering stays anchored to the server clock.
    const turn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: 'Same content',
      // Client clock ahead — later than the mail's server timestamp.
      timestamp: '2024-01-01T00:09:00.000Z',
    };
    const { messages } = composeChatMessages({
      events: [
        userMail('u1', 'hi', '2024-01-01T00:00:00.000Z'),
        turn,
        assistantMail('a1', 'Same content', '2024-01-01T00:00:30.000Z'),
      ],
      streaming: '',
    });
    const agentMessages = messages.filter(
      (m) => m.role === 'agent' && m.content === 'Same content'
    );
    expect(agentMessages).toHaveLength(1);
    // The surviving message is the mail (server timestamp), not the turn.
    expect(agentMessages[0]?.id).toBe('a1');
  });

  it('orders the last sent message below the prior response despite a skewed turn clock', () => {
    // Reproduces the live bug: the prior reply's turn carries a client clock that
    // runs ahead of the next user mail's server timestamp. Because the text turn
    // is dropped in favour of the server-timestamped mail, the new user message
    // stays below the response after sorting.
    const turn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: 'first answer',
      timestamp: '2024-01-01T00:09:00.000Z', // skewed-ahead client clock
    };
    const { messages } = composeChatMessages({
      events: [
        userMail('u1', 'first', '2024-01-01T00:00:00.000Z'),
        turn,
        assistantMail('a1', 'first answer', '2024-01-01T00:00:30.000Z'),
        userMail('u2', 'second', '2024-01-01T00:01:00.000Z'),
      ],
      streaming: '',
    });
    expect(messages.map((m) => m.content)).toEqual(['first', 'first answer', 'second']);
  });

  it('keeps a tool-call turn and drops the assistant mail that echoes it', () => {
    const toolTurn: InstanceEvent = {
      kind: 'turn',
      turnId: 't1',
      content: 'Done searching',
      timestamp: '2024-01-01T00:00:30.000Z',
      toolCalls: [{ name: 'exa_search', arguments: { query: 'x' }, result: 'r', isError: false }],
    };
    const { messages } = composeChatMessages({
      events: [userMail('u1', 'search'), toolTurn, assistantMail('a1', 'Done searching')],
      streaming: '',
    });
    const agentMessages = messages.filter((m) => m.role === 'agent');
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.id).toBe('t1');
    expect(agentMessages[0]?.toolCalls?.[0]?.name).toBe('exa_search');
  });
});
