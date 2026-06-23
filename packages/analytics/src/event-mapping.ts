import type { InferenceEvent } from '@intx/types/runtime';

export type AnalyticsEventType =
  | 'inference_usage'
  | 'inference_done'
  | 'tool_call'
  | 'turn_completed'
  | 'turn_failed';

export type AnalyticsFact = {
  eventKey: string;
  eventType: AnalyticsEventType;
  model: string | null;
  toolCallId: string | null;
  toolName: string | null;
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
          toolName: null,
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
          toolName: null,
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
    case 'tool.done': {
      const result = event.data.result;
      return [
        {
          eventKey: `${baseKey}:${result.callId}`,
          eventType: 'tool_call',
          model: null,
          toolCallId: result.callId,
          toolName: null,
          status: result.isError === true ? 'error' : 'completed',
          ...tokens(null),
          source: null,
          metadata: { isError: result.isError === true },
          occurredAt: now,
        },
      ];
    }
    case 'reactor.done':
      return [
        {
          eventKey: baseKey,
          eventType: 'turn_completed',
          model: null,
          toolCallId: null,
          toolName: null,
          status: 'completed',
          ...tokens(null),
          source: null,
          metadata: null,
          occurredAt: now,
        },
      ];
    case 'reactor.error':
      return [
        {
          eventKey: baseKey,
          eventType: 'turn_failed',
          model: null,
          toolCallId: null,
          toolName: null,
          status: 'failed',
          ...tokens(null),
          source: null,
          metadata: { error: event.data.error, fatal: event.data.fatal },
          occurredAt: now,
        },
      ];
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
