import { type } from 'arktype';
import {
  EPHEMERAL_COMPACT_THRESHOLD_TOKENS,
  EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT,
} from './budget';
import { estimateTextTokens } from './tokens';

export const EPHEMERAL_CHAT_TAG = 'workbench.ephemeralChat';

const HistoryTurn = type({
  role: "'user' | 'assistant'",
  content: 'string',
});

export const EphemeralChatPayload = type({
  message: 'string',
  history: HistoryTurn.array(),
});

export type EphemeralChatPayload = typeof EphemeralChatPayload.infer;

export type EphemeralChatCompactionMeta = {
  droppedTurns: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
};

export type EphemeralChatCompactResult = {
  payload: EphemeralChatPayload;
  compaction?: EphemeralChatCompactionMeta;
};

function estimatePayloadTokens(systemPrompt: string, payload: EphemeralChatPayload): number {
  const body = JSON.stringify({ message: payload.message, history: payload.history });
  return estimateTextTokens(systemPrompt) + estimateTextTokens(body);
}

function summarizeDroppedTurns(turns: EphemeralChatPayload['history']): string {
  if (turns.length === 0) return '';
  const lines = turns.map((turn) => {
    const snippet = turn.content.length > 240 ? `${turn.content.slice(0, 240)}…` : turn.content;
    return `- ${turn.role}: ${snippet}`;
  });
  return `[Earlier conversation compacted — ${turns.length} turn(s) summarized to fit context.]\n${lines.join('\n')}`;
}

function truncateMessageToTarget(
  systemPrompt: string,
  message: string,
  history: EphemeralChatPayload['history']
): string {
  let trimmed = message;
  while (
    trimmed.length > 0 &&
    estimatePayloadTokens(systemPrompt, { message: trimmed, history }) >
      EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT
  ) {
    const nextLen = Math.max(1, Math.floor(trimmed.length * 0.85));
    if (nextLen >= trimmed.length) break;
    trimmed = `${trimmed.slice(0, nextLen)}…`;
  }
  if (
    estimatePayloadTokens(systemPrompt, { message: trimmed, history }) >
    EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT
  ) {
    throw new Error(
      'ephemeral chat: input still exceeds context budget after compaction; shorten the message or history'
    );
  }
  return trimmed;
}

/**
 * Prune and summarize history when the inline step input exceeds the v1 token
 * threshold. Returns model-safe `payload` only (metadata is separate).
 */
export function compactEphemeralChatInput(
  input: unknown,
  systemPrompt: string
): EphemeralChatCompactResult {
  const parsed = EphemeralChatPayload(input);
  if (parsed instanceof type.errors) {
    throw new Error(`ephemeral chat: invalid step input — ${parsed.summary}`);
  }

  const estimatedBefore = estimatePayloadTokens(systemPrompt, parsed);
  if (estimatedBefore < EPHEMERAL_COMPACT_THRESHOLD_TOKENS) {
    return { payload: parsed };
  }

  const dropped: EphemeralChatPayload['history'] = [];
  let history = [...parsed.history];
  let message = parsed.message;

  let working: EphemeralChatPayload = { message, history };
  while (
    history.length > 0 &&
    estimatePayloadTokens(systemPrompt, working) > EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT
  ) {
    const removed = history.shift();
    if (removed === undefined) break;
    dropped.push(removed);
    working = { message, history: [...history] };
  }

  if (dropped.length > 0) {
    const summary = summarizeDroppedTurns(dropped);
    history = [{ role: 'user', content: summary }, ...history];
    working = { message, history };
  }

  if (estimatePayloadTokens(systemPrompt, working) > EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT) {
    message = truncateMessageToTarget(systemPrompt, message, history);
    working = { message, history };
  }

  const estimatedAfter = estimatePayloadTokens(systemPrompt, working);

  return {
    payload: working,
    compaction: {
      droppedTurns: dropped.length,
      estimatedTokensBefore: estimatedBefore,
      estimatedTokensAfter: estimatedAfter,
    },
  };
}