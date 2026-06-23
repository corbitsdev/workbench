import { describe, expect, test } from 'bun:test';

import type { InferenceEvent } from '@intx/types/runtime';

import { factsFromInferenceEvent } from './event-mapping';

const occurredAt = new Date('2026-06-23T00:00:00.000Z');

describe('factsFromInferenceEvent', () => {
  test('maps inference usage with token and model attribution', () => {
    const event: InferenceEvent = {
      type: 'inference.usage',
      seq: 7,
      data: {
        usage: {
          input: 100,
          output: 11,
          cacheRead: 50,
          cacheWrite: 3,
          thinking: 2,
        },
        source: {
          sourceId: 'src_openrouter',
          provider: 'openai-compatible',
          model: 'anthropic/claude-sonnet-4',
        },
      },
    };

    expect(
      factsFromInferenceEvent({
        agentAddress: 'agent@example.test',
        event,
        now: occurredAt,
      })
    ).toEqual([
      {
        eventKey: 'agent@example.test:7:inference.usage',
        eventType: 'inference_usage',
        model: 'anthropic/claude-sonnet-4',
        toolCallId: null,
        status: null,
        inputTokens: 100,
        outputTokens: 11,
        cacheReadTokens: 50,
        cacheWriteTokens: 3,
        thinkingTokens: 2,
        source: {
          sourceId: 'src_openrouter',
          provider: 'openai-compatible',
          model: 'anthropic/claude-sonnet-4',
        },
        metadata: null,
        occurredAt,
      },
    ]);
  });

  test('maps tool results with a stable event key and error metadata', () => {
    const event: InferenceEvent = {
      type: 'tool.done',
      seq: 12,
      data: {
        result: {
          callId: 'call_123',
          content: 'boom',
          isError: true,
        },
      },
    };

    expect(
      factsFromInferenceEvent({
        agentAddress: 'agent@example.test',
        event,
        now: occurredAt,
      })
    ).toEqual([
      {
        eventKey: 'agent@example.test:12:tool.done:call_123',
        eventType: 'tool_call',
        model: null,
        toolCallId: 'call_123',
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        source: null,
        metadata: { isError: true },
        occurredAt,
      },
    ]);
  });

  test('ignores events that analytics does not aggregate', () => {
    const event: InferenceEvent = {
      type: 'inference.text.delta',
      seq: 3,
      data: {
        token: 'hello',
        partial: { text: 'hello' },
      },
    };

    expect(
      factsFromInferenceEvent({
        agentAddress: 'agent@example.test',
        event,
        now: occurredAt,
      })
    ).toEqual([]);
  });

  test('maps message.run.ended completed to turn_completed with zero tokens', () => {
    const event: InferenceEvent = {
      type: 'message.run.ended',
      seq: 20,
      data: { messageRunId: 'mrn_1', messageId: 'msg_1', status: 'completed' },
    };

    expect(
      factsFromInferenceEvent({ agentAddress: 'agent@example.test', event, now: occurredAt })
    ).toEqual([
      {
        eventKey: 'agent@example.test:20:message.run.ended',
        eventType: 'turn_completed',
        model: null,
        toolCallId: null,
        status: 'completed',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        source: null,
        metadata: null,
        occurredAt,
      },
    ]);
  });

  test('maps message.run.ended failed to turn_failed with error metadata', () => {
    const event: InferenceEvent = {
      type: 'message.run.ended',
      seq: 21,
      data: {
        messageRunId: 'mrn_2',
        messageId: 'msg_2',
        status: 'failed',
        error: { message: 'context limit exceeded', kind: 'reactor_fatal' },
      },
    };

    expect(
      factsFromInferenceEvent({ agentAddress: 'agent@example.test', event, now: occurredAt })
    ).toEqual([
      {
        eventKey: 'agent@example.test:21:message.run.ended',
        eventType: 'turn_failed',
        model: null,
        toolCallId: null,
        status: 'failed',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        source: null,
        metadata: { message: 'context limit exceeded', kind: 'reactor_fatal' },
        occurredAt,
      },
    ]);
  });

  test('maps inference.error to inference_error fact with error metadata', () => {
    const event: InferenceEvent = {
      type: 'inference.error',
      seq: 8,
      data: {
        error: { category: 'quota_exhausted', message: 'rate limit exceeded' },
        partial: { text: '' },
      },
    };

    expect(
      factsFromInferenceEvent({ agentAddress: 'agent@example.test', event, now: occurredAt })
    ).toEqual([
      {
        eventKey: 'agent@example.test:8:inference.error',
        eventType: 'inference_error',
        model: null,
        toolCallId: null,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        source: null,
        metadata: { category: 'quota_exhausted', message: 'rate limit exceeded' },
        occurredAt,
      },
    ]);
  });

  test('reactor.done is not mapped (session-level shutdown, not a per-turn event)', () => {
    const event: InferenceEvent = {
      type: 'reactor.done',
      seq: 30,
      data: {},
    };

    expect(
      factsFromInferenceEvent({ agentAddress: 'agent@example.test', event, now: occurredAt })
    ).toEqual([]);
  });
});
