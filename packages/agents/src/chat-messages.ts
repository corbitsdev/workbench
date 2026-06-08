import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage } from '@workbench/chat';
import { convertInstanceEvents } from './adapter';

/**
 * Cross-render state for the disappearing-response mitigation. The host keeps
 * this in a ref and passes it back on each compose call.
 *
 * `text` is the last streamed assistant text; `afterUserId` is the id of the
 * user message it was a reply to, so a stale reply is dropped once a new user
 * message arrives.
 */
export interface RetainedAgentText {
  text: string;
  afterUserId: string | null;
}

export const EMPTY_RETAINED: RetainedAgentText = { text: '', afterUserId: null };

export interface ComposeChatInput {
  events: InstanceEvent[];
  /** Live streaming buffer from the session (empty when not streaming). */
  streaming: string;
  /** callId -> tool-name map captured from the live stream. */
  toolNames?: ReadonlyMap<string, string>;
  /** Retained streamed text from the previous compose call. */
  retained?: RetainedAgentText;
}

export interface ComposeChatResult {
  messages: ChatMessage[];
  /** Retained text to store back in the host ref for the next render. */
  retained: RetainedAgentText;
}

/**
 * Build the chat message list from session events plus the live streaming
 * buffer.
 *
 * The hub can fail to persist a turn's text part (CL-1398), so `turn.committed`
 * may carry empty text and the durable assistant reply only lands later as a
 * mail event. Without mitigation the streamed text the user watched appear
 * blinks out in the gap. We keep showing the last streamed text until a durable
 * agent reply (non-empty turn/mail or a tool call) lands for that same user
 * message.
 */
export function composeChatMessages(input: ComposeChatInput): ComposeChatResult {
  const { events, streaming, toolNames, retained = EMPTY_RETAINED } = input;

  // Drop assistant mail whose content already appears in a committed turn, so
  // the same reply is not rendered twice.
  const turnContent = new Set(events.filter((e) => e.kind === 'turn').map((e) => e.content.trim()));
  const deduped = events.filter(
    (e) => !(e.kind === 'mail' && e.role === 'assistant' && turnContent.has(e.content.trim()))
  );

  const messages = convertInstanceEvents(deduped, toolNames);

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const lastUserId = lastUserIdx >= 0 ? (messages[lastUserIdx]?.id ?? null) : null;

  // A durable reply exists when, after the last user message, an agent message
  // carries content or tool calls.
  const hasAgentReply = messages
    .slice(lastUserIdx + 1)
    .some((m) => m.role === 'agent' && (m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0));

  const live = streaming.trim() !== '';

  let nextRetained: RetainedAgentText;
  if (live) {
    nextRetained = { text: streaming, afterUserId: lastUserId };
  } else if (hasAgentReply || retained.afterUserId !== lastUserId) {
    // Either the durable reply landed, or a newer user message arrived and the
    // retained text is now stale.
    nextRetained = EMPTY_RETAINED;
  } else {
    nextRetained = retained;
  }

  if (nextRetained.text.trim() !== '') {
    messages.push({
      id: 'streaming',
      role: 'agent',
      content: nextRetained.text,
      createdAt: new Date().toISOString(),
      ...(live ? { status: 'sending' as const } : {}),
    });
  }

  return { messages, retained: nextRetained };
}
