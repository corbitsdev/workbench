import { describe, expect, it, mock } from 'bun:test';
import type {
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
  ToolDefinition,
} from '@intx/types/runtime';
import { createGranolaDirector } from './director';

function makeCapabilities(): ReactorCapabilities & {
  replyArg: string | undefined;
} {
  const cap = {
    replyArg: undefined as string | undefined,
    infer: mock(() => ({ type: 'infer' as const })),
    executeTools: mock(() => ({ type: 'execute_tools' as const, calls: [] })),
    suspend: mock(() => ({
      type: 'suspend' as const,
      gate: { type: 'approval' as const, gateId: '', timeoutMs: 0 },
    })),
    fork: mock(() => ({
      type: 'fork' as const,
      mode: 'independent' as const,
      forkId: '',
    })),
    emit: mock(() => ({ type: 'emit' as const, eventType: 'custom.x' as const, data: {} })),
    reply(content: string) {
      cap.replyArg = content;
      return { type: 'reply' as const, content };
    },
    checkpoint: mock(() => ({ type: 'checkpoint' as const, message: '' })),
    compact: mock(() => ({
      type: 'compact' as const,
      compactor: '',
      reason: '',
    })),
    wait: mock(() => ({ type: 'wait' as const })),
    done: mock(() => ({ type: 'done' as const })),
  };
  return cap;
}

function makeState(): ReactorState {
  return {
    turns: [],
    activeForks: [],
    pendingOperations: [],
    activeGates: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    lastCycleUsage: null,
    lastCycleSource: null,
    sessionId: 'test-session',
  };
}

function makeMessageEvent(from: string): ReactorInboundEvent {
  return {
    type: 'message.received',
    message: {
      ref: { uid: 2, mailbox: 'INBOX' },
      headers: {
        from,
        to: ['granola@workbench.example'],
        date: new Date().toISOString(),
        messageId: 'msg-2@test',
      },
      flags: [],
      content: 'Summarize my calls',
      signatureStatus: 'valid',
    },
  };
}

describe('createGranolaDirector', () => {
  const tools: ToolDefinition[] = [];
  const systemPrompt = 'You are the Granola agent.';
  const adaAddress = 'ada@personal.example';

  it('allows messages from Myra and delegates to base director', async () => {
    const director = createGranolaDirector(systemPrompt, tools, [adaAddress]);
    const cap = makeCapabilities();
    const event = makeMessageEvent(adaAddress);

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === 'infer')).toBe(true);
  });

  it('rejects messages from non-Ada senders', async () => {
    const director = createGranolaDirector(systemPrompt, tools, [adaAddress]);
    const cap = makeCapabilities();
    const event = makeMessageEvent('impostor@evil.com');

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === 'reply')).toBe(true);
    expect(cap.replyArg).toBe('Not authorised');
  });
});
