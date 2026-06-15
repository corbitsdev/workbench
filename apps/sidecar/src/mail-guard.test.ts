import { describe, expect, it } from 'bun:test';
import type { ToolCall, ToolDefinition, ToolResult, ToolRunner } from '@intx/types/runtime';
import {
  createGuardedMailRunner,
  MAX_IDENTICAL_OUTBOUND,
  MAX_OUTBOUND_PER_TURN,
} from './mail-guard';

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

function def(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object', properties: {}, required: [] } };
}

function countingRunner(): DefinedRunner & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    definitions: [def('mail_send'), def('mail_reply'), def('mail_search')],
    run(call: ToolCall): Promise<ToolResult> {
      calls.push(call);
      return Promise.resolve({ callId: call.id, content: { ok: true } });
    },
  };
}

function send(id: string, content: string): ToolCall {
  return { id, name: 'mail_send', arguments: { to: 'ins_x@gtm.localhost', content } };
}

describe('createGuardedMailRunner', () => {
  it('suppresses identical outbound mail after the first send', async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const results: ToolResult[] = [];
    for (let i = 0; i < 15; i++) {
      results.push(await guarded.run(send(`c${i}`, 'the browser timed out'), signal));
    }

    // Only the first identical body reaches the real runner.
    expect(inner.calls).toHaveLength(MAX_IDENTICAL_OUTBOUND);
    const blocked = results.filter((r) => r.isError);
    expect(blocked).toHaveLength(15 - MAX_IDENTICAL_OUTBOUND);
    expect(JSON.stringify(blocked[0]?.content)).toContain('Duplicate');
  });

  it('allows the same body sent to different recipients (fan-out)', async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const recipients = ['ins_a@gtm.localhost', 'ins_b@gtm.localhost', 'ins_c@gtm.localhost'];
    for (const [i, to] of recipients.entries()) {
      await guarded.run(
        { id: `c${i}`, name: 'mail_send', arguments: { to, content: 'same announcement' } },
        signal
      );
    }

    expect(inner.calls).toHaveLength(3);
  });

  it('caps total distinct outbound mail per turn', async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const results: ToolResult[] = [];
    for (let i = 0; i < MAX_OUTBOUND_PER_TURN + 3; i++) {
      results.push(await guarded.run(send(`c${i}`, `distinct body ${i}`), signal));
    }

    expect(inner.calls).toHaveLength(MAX_OUTBOUND_PER_TURN);
    expect(results.filter((r) => r.isError)).toHaveLength(3);
    const lastBlocked = results[results.length - 1];
    expect(JSON.stringify(lastBlocked?.content)).toContain('cap');
  });

  it('passes through non-mail-write tools untouched', async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const searchCall: ToolCall = { id: 's1', name: 'mail_search', arguments: { query: {} } };
    for (let i = 0; i < 20; i++) await guarded.run(searchCall, signal);

    expect(inner.calls).toHaveLength(20);
  });

  it('does not count a failed send against the budget', async () => {
    const calls: ToolCall[] = [];
    const failing: DefinedRunner = {
      definitions: [def('mail_send')],
      run(call: ToolCall): Promise<ToolResult> {
        calls.push(call);
        return Promise.resolve({ callId: call.id, content: { error: 'boom' }, isError: true });
      },
    };
    const guarded = createGuardedMailRunner(failing);
    const signal = new AbortController().signal;

    // Distinct bodies that all fail downstream should keep reaching the runner;
    // a failed send neither consumed the budget nor counts as "already sent".
    for (let i = 0; i < MAX_OUTBOUND_PER_TURN + 2; i++) {
      await guarded.run(send(`c${i}`, `body ${i}`), signal);
    }
    expect(calls).toHaveLength(MAX_OUTBOUND_PER_TURN + 2);
  });
});
