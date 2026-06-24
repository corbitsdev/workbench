import type { InferenceEvent } from '@intx/types/runtime';

export type AnalyticsEventType =
  | 'inference_usage'
  | 'inference_done'
  | 'inference_error'
  | 'tool_call'
  | 'turn_completed'
  | 'turn_failed';

export type AnalyticsFact = {
  eventKey: string;
  eventType: AnalyticsEventType;
  model: string | null;
  toolCallId: string | null;
  status: 'running' | 'completed' | 'failed' | 'error' | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  source: unknown | null;
  metadata: unknown | null;
  occurredAt: Date;
};

export function factsFromInferenceEvent(args: {
  agentAddress: string;
  event: InferenceEvent;
  now?: Date;
}): AnalyticsFact[] {
  const { agentAddress, event, now = new Date() } = args;
  const baseKey = `${agentAddress}:${event.seq}:${event.type}`;

  switch (event.type) {
    case 'inference.usage':
      return [
        {
          eventKey: baseKey,
          eventType: 'inference_usage',
          model: event.data.source.model,
          toolCallId: null,
          status: null,
          ...tokens(event.data.usage),
          source: event.data.source,
          metadata: null,
          occurredAt: now,
        },
      ];
    case 'inference.done':
      return [
        {
          eventKey: baseKey,
          eventType: 'inference_done',
          model: event.data.source.model,
          toolCallId: null,
          status: 'completed',
          ...tokens(event.data.usage),
          source: event.data.source,
          metadata:
            event.data.pacingDelayMs === undefined
              ? null
              : { pacingDelayMs: event.data.pacingDelayMs },
          occurredAt: now,
        },
      ];
    case 'inference.error':
      return [
        {
          eventKey: baseKey,
          eventType: 'inference_error',
          model: null,
          toolCallId: null,
          status: 'error',
          ...tokens(null),
          source: null,
          metadata: { category: event.data.error.category, message: event.data.error.message },
          occurredAt: now,
        },
      ];
    case 'tool.done': {
      const result = event.data.result;
      return [
        {
          eventKey: `${baseKey}:${result.callId}`,
          eventType: 'tool_call',
          model: null,
          toolCallId: result.callId,
          status: result.isError === true ? 'error' : 'completed',
          ...tokens(null),
          source: null,
          metadata: { isError: result.isError === true },
          occurredAt: now,
        },
      ];
    }
    // message.run.ended is the per-turn boundary event (one per user message processed).
    // reactor.done fires once at session shutdown — not a per-turn event, not mapped.
    // reactor.error fires for non-fatal mid-session errors — not a turn failure, not mapped.
    case 'message.run.ended':
      return [
        {
          eventKey: baseKey,
          eventType: event.data.status === 'completed' ? 'turn_completed' : 'turn_failed',
          model: null,
          toolCallId: null,
          status: event.data.status,
          ...tokens(null),
          source: null,
          metadata: event.data.error ?? null,
          occurredAt: now,
        },
      ];
    // inference.retry fires between retry attempts — terminal usage is attributed on
    // inference.done for the successful attempt. No additional rollup contribution.
    default:
      return [];
  }
}

function tokens(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  } | null
) {
  return {
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    thinkingTokens: usage?.thinking ?? 0,
  };
}
