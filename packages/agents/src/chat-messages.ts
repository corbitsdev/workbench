import type { InstanceEvent } from '@intx/hub-client';
import type { ChatMessage } from '@workbench/chat';
import { convertInstanceEvents } from './adapter';

export const STREAMING_BUBBLE_ID = 'streaming-synthetic';

export interface ComposeChatInput {
  events: InstanceEvent[];
  /** Live streaming buffer from the session (empty when not streaming). */
  streaming: string;
  /** callId -> tool-name map captured from the live stream. */
  toolNames?: ReadonlyMap<string, string>;
  /** Live reasoning buffer for the current turn (empty when not thinking). */
  reasoning?: string;
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
  const { events, streaming, toolNames, reasoning = '' } = input;

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

  const converted = convertInstanceEvents(deduped, toolNames);

  // Deduplicate by message id. The session layer already deduplicates events
  // by id, but guard here too in case two different code paths produce the
  // same id (e.g. a hydration race that drains the SSE buffer after the REST
  // fetch returns the same mail).
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const msg of converted) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id);
      messages.push(msg);
    }
  }

  // The hub can fail to persist a turn's text part (CL-1398), so turn.committed
  // may arrive with empty text while the streamed text the user watched is still
  // in the live buffer. Surface it by overwriting that empty trailing bubble.
  //
  // The live text belongs to the turn currently streaming, which has not
  // committed yet — so it never matches an already-committed, non-empty bubble.
  // Only overwrite a trailing agent bubble that is EMPTY (the CL-1398 case);
  // otherwise synthesize a new streaming bubble. Overwriting a non-empty
  // committed bubble would transiently mask it: in a multi-step tool-loop reply,
  // an earlier text segment commits as its own bubble and the next segment's
  // live text would paint over it until it commits (CL-1643).
  //
  // `streaming` here is the current turn's live text only — the caller sources
  // it from createLiveTextTracker, which reads each delta's per-turn cumulative
  // `partial.text` and resets on turn.committed. It must NOT be the interchange
  // session's `streaming` buffer, which accumulates across turns when a turn
  // commits empty and would merge separate replies into one bubble (CL-1643).
  // Attach the current turn's live text and reasoning to the streaming bubble.
  // Reasoning can be present before any answer text (the "thinking" phase), so
  // a streaming bubble is synthesized when either is non-empty. The reasoning
  // tracker, like the text tracker, resets on turn.committed — so this is the
  // current turn only and never bleeds across turns (CL-1643).
  const liveText = streaming.trim();
  const liveReasoning = reasoning.trim();
  if (liveText !== '' || liveReasoning !== '') {
    const last = messages[messages.length - 1];
    if (last?.role === 'agent' && last.content === '') {
      if (liveText !== '') last.content = streaming;
      if (liveReasoning !== '') last.reasoning = reasoning;
      last.status = 'sending';
    } else if (liveText !== '') {
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: 'agent',
        content: streaming,
        createdAt: new Date().toISOString(),
        status: 'sending',
        ...(liveReasoning !== '' ? { reasoning } : {}),
      });
    } else {
      // Reasoning only — the agent is thinking and has not started answering.
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: 'agent',
        content: '',
        createdAt: new Date().toISOString(),
        status: 'sending',
        reasoning,
      });
    }
  }

  return { messages };
}
