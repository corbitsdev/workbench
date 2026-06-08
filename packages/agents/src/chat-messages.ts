import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage } from '@workbench/chat';
import { convertInstanceEvents } from './adapter';

export interface ComposeChatInput {
  events: InstanceEvent[];
  /** Live streaming buffer from the session (empty when not streaming). */
  streaming: string;
  /** callId -> tool-name map captured from the live stream. */
  toolNames?: ReadonlyMap<string, string>;
}

export interface ComposeChatResult {
  messages: ChatMessage[];
}

/**
 * Build the chat message list from session events plus the live streaming
 * buffer.
 *
 * Mirrors the deal-scout `eventsToMessages` approach: dedup mail that echoes a
 * turn, map to chat messages, fold in the live streaming buffer, then sort the
 * final list by timestamp so chronology is stable regardless of the order the
 * session happened to accumulate events in (hydrated events are server-sorted,
 * but live SSE events are appended raw and turn events carry client-side
 * timestamps).
 */
export function composeChatMessages(input: ComposeChatInput): ComposeChatResult {
  const { events, streaming, toolNames } = input;

  // Drop assistant mail whose content already appears in a committed turn, so
  // the same reply is not rendered twice.
  const turnContent = new Set(events.filter((e) => e.kind === 'turn').map((e) => e.content.trim()));
  const deduped = events.filter(
    (e) => !(e.kind === 'mail' && e.role === 'assistant' && turnContent.has(e.content.trim()))
  );

  const messages = convertInstanceEvents(deduped, toolNames);

  // The hub can fail to persist a turn's text part (CL-1398), so turn.committed
  // may arrive with empty text while the streamed text the user watched is still
  // in the live buffer. Surface it: overwrite the trailing assistant bubble's
  // content when one exists, otherwise synthesize a streaming bubble.
  if (streaming.trim() !== '') {
    const last = messages[messages.length - 1];
    if (last?.role === 'agent') {
      last.content = streaming;
      last.status = 'sending';
    } else {
      messages.push({
        id: 'streaming-synthetic',
        role: 'agent',
        content: streaming,
        createdAt: new Date().toISOString(),
        status: 'sending',
      });
    }
  }

  // Ensure stable chronology regardless of how the session ordered events.
  messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return { messages };
}
