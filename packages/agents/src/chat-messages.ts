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
 * Ordering is anchored to server timestamps. A text reply exists as BOTH a
 * committed turn (timestamped with the client clock — `new Date()` at commit)
 * and an outbound mail (timestamped with the server's `receivedAt`). Sorting a
 * mix of the two clocks corrupts live order: when the client clock runs ahead,
 * a turn sorts after a newer user mail and the last sent message jumps above the
 * response (until a hard reload, where text-only turns drop out and everything
 * is back on server time).
 *
 * So when a turn and a mail carry the same text we keep the MAIL (server clock)
 * and drop the turn — unless the turn carries tool calls, which the mail does
 * not represent, in which case we keep the turn and drop the echoing mail. Every
 * surviving text message then has a server timestamp, so the final timestamp
 * sort is clock-consistent.
 */
export function composeChatMessages(input: ComposeChatInput): ComposeChatResult {
  const { events, streaming, toolNames } = input;

  // Content of assistant mail (server-timestamped) and of turns that carry tool
  // calls (the only thing mail cannot represent).
  const assistantMailContent = new Set(
    events.filter((e) => e.kind === 'mail' && e.role === 'assistant').map((e) => e.content.trim())
  );
  const toolTurnContent = new Set(
    events
      .filter((e) => e.kind === 'turn' && (e.toolCalls?.length ?? 0) > 0)
      .map((e) => e.content.trim())
  );

  const deduped = events.filter((e) => {
    // A text-only turn echoed by an assistant mail is redundant: drop it so the
    // server-timestamped mail wins.
    if (
      e.kind === 'turn' &&
      (e.toolCalls?.length ?? 0) === 0 &&
      assistantMailContent.has(e.content.trim())
    ) {
      return false;
    }
    // An assistant mail echoed by a tool-call turn is redundant: keep the turn
    // (it carries the tool narrative).
    if (e.kind === 'mail' && e.role === 'assistant' && toolTurnContent.has(e.content.trim())) {
      return false;
    }
    return true;
  });

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

  return { messages };
}
