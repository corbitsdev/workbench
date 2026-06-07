/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { compactMessages } from './compactMessages';
import { type ChatMessage } from './types';

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'agent',
    content: `Message ${id}`,
    createdAt: '2026-06-06T00:00:00Z',
    ...overrides,
  };
}

function toolMsg(id: string): ChatMessage {
  return makeMessage(id, { kind: 'tool' });
}

function userMsg(id: string): ChatMessage {
  return makeMessage(id, { role: 'user' });
}

function artifactMsg(id: string): ChatMessage {
  return makeMessage(id, { kind: 'artifact' });
}

function failedMsg(id: string): ChatMessage {
  return makeMessage(id, { status: 'failed' });
}

describe('compactMessages', () => {
  it('returns messages unchanged when count is at or below threshold', () => {
    const msgs = [toolMsg('1'), toolMsg('2'), toolMsg('3')];
    const result = compactMessages(msgs, 10);
    expect(result.every((i) => i.type === 'message')).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('does not compact when threshold is 0', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => toolMsg(String(i)));
    const result = compactMessages(msgs, 0);
    expect(result.every((i) => i.type === 'message')).toBe(true);
  });

  it('collapses a run of tool messages in the head', () => {
    // 11 messages: 6 tool in head + 5 tail
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      toolMsg('t3'),
      toolMsg('t4'),
      toolMsg('t5'),
      toolMsg('t6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
      makeMessage('a11'),
    ];
    const result = compactMessages(msgs, 10, 5);

    // Head (6 items): t1-t6 are all tool → one collapsed group
    const groups = result.filter((i) => i.type === 'collapsed_group');
    expect(groups).toHaveLength(1);
    if (groups[0]?.type === 'collapsed_group') {
      expect(groups[0].count).toBe(6);
    }

    // Tail (5 items): a7-a11, all visible
    const visible = result.filter((i) => i.type === 'message');
    expect(visible).toHaveLength(5);
  });

  it('never collapses user messages', () => {
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      userMsg('u1'),
      toolMsg('t3'),
      toolMsg('t4'),
      toolMsg('t5'),
      makeMessage('a6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
    ];
    const result = compactMessages(msgs, 10, 5);
    const userItems = result.filter((i) => i.type === 'message' && i.message.role === 'user');
    expect(userItems).toHaveLength(1);
  });

  it('never collapses error (failed) messages', () => {
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      failedMsg('f1'),
      toolMsg('t3'),
      toolMsg('t4'),
      makeMessage('a5'),
      makeMessage('a6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
    ];
    const result = compactMessages(msgs, 10, 5);
    const failedItems = result.filter((i) => i.type === 'message' && i.message.status === 'failed');
    expect(failedItems).toHaveLength(1);
  });

  it('never collapses artifact messages', () => {
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      artifactMsg('art1'),
      toolMsg('t3'),
      toolMsg('t4'),
      makeMessage('a5'),
      makeMessage('a6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
    ];
    const result = compactMessages(msgs, 10, 5);
    const artifactItems = result.filter(
      (i) => i.type === 'message' && i.message.kind === 'artifact'
    );
    expect(artifactItems).toHaveLength(1);
  });

  it('the most recent recentWindow messages are always fully visible', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => toolMsg(String(i + 1)));
    const result = compactMessages(msgs, 10, 5);
    // Last 5 should be fully visible message items
    const tail = result.slice(-5);
    expect(tail.every((i) => i.type === 'message')).toBe(true);
    const tailIds = tail.filter((i) => i.type === 'message').map((i) => i.message.id);
    expect(tailIds).toEqual(['11', '12', '13', '14', '15']);
  });

  it('a single-item compactable run is shown directly (not wrapped)', () => {
    // Head has just one tool message (not enough to form a multi-item group)
    const msgs = [
      toolMsg('t1'),
      makeMessage('a2'),
      makeMessage('a3'),
      makeMessage('a4'),
      makeMessage('a5'),
      makeMessage('a6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
      makeMessage('a11'),
    ];
    const result = compactMessages(msgs, 10, 5);
    // t1 is alone in head — shown as message
    const firstItem = result[0];
    expect(firstItem?.type).toBe('message');
    expect(result.filter((i) => i.type === 'collapsed_group')).toHaveLength(0);
  });

  it('separating a run of tools with a non-tool message creates two groups', () => {
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      makeMessage('a3'),
      toolMsg('t4'),
      toolMsg('t5'),
      toolMsg('t6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
      makeMessage('a11'),
    ];
    const result = compactMessages(msgs, 10, 5);
    const groups = result.filter((i) => i.type === 'collapsed_group');
    expect(groups).toHaveLength(2);
  });

  it('collapsed group exposes its constituent messages', () => {
    const msgs = [
      toolMsg('t1'),
      toolMsg('t2'),
      toolMsg('t3'),
      makeMessage('a4'),
      makeMessage('a5'),
      makeMessage('a6'),
      makeMessage('a7'),
      makeMessage('a8'),
      makeMessage('a9'),
      makeMessage('a10'),
      makeMessage('a11'),
    ];
    const result = compactMessages(msgs, 10, 5);
    const group = result.find((i) => i.type === 'collapsed_group');
    expect(group?.type).toBe('collapsed_group');
    if (group?.type === 'collapsed_group') {
      expect(group.messages.map((m) => m.id)).toEqual(['t1', 't2', 't3']);
    }
  });
});
