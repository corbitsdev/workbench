import type { InstanceEvent } from "@intx/hub-client";
import type { ChatMessage, ChatImage } from "@workbench/chat";
import { convertInstanceEvents } from "./adapter";

export const STREAMING_BUBBLE_ID = "streaming-synthetic";

export interface ComposeChatInput {
  events: InstanceEvent[];
  /** Live streaming buffer from the session (empty when not streaming). */
  streaming: string;
  /** callId -> tool-name map captured from the live stream. */
  toolNames?: ReadonlyMap<string, string>;
  /** Live reasoning buffer for the current turn (empty when not thinking). */
  reasoning?: string;
  /** Inline images captured from the current turn's live stream. */
  liveImages?: readonly ChatImage[];
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
 * not represent, in which case we keep the turn and drop the echoing mail.
 *
 * The surviving mail is emitted at the EARLIEST position of its content — the
 * dropped turn's slot — not wherever the mail itself lands in the append-only
 * event array. Events are appended in arrival order and only re-sorted on a
 * hard reload (CL-1788): the assistant mail can be delivered late, after a
 * newer user message. Leaving the mail at its tail position would drop the
 * prior reply below the just-sent message. Anchoring it to the turn's slot
 * keeps the reply above the newer message without a clock-mixing sort.
 */
export function composeChatMessages(
  input: ComposeChatInput,
): ComposeChatResult {
  const { events, streaming, toolNames, reasoning = "", liveImages } = input;

  // Content of assistant mail (server-timestamped) and of turns that carry tool
  // calls (the only thing mail cannot represent).
  const assistantMailContent = new Set(
    events
      .filter((e) => e.kind === "mail" && e.role === "assistant")
      .map((e) => e.content.trim()),
  );
  const toolTurnContent = new Set(
    events
      .filter((e) => e.kind === "turn" && (e.toolCalls?.length ?? 0) > 0)
      .map((e) => e.content.trim()),
  );
  // Assistant mails grouped by content, in arrival order. A text-only turn is
  // matched to the next not-yet-hoisted mail of the same content so distinct
  // replies that happen to share identical text are not collapsed together.
  const assistantMailsByContent = new Map<string, InstanceEvent[]>();
  for (const e of events) {
    if (e.kind === "mail" && e.role === "assistant") {
      const content = e.content.trim();
      const group = assistantMailsByContent.get(content);
      if (group) group.push(e);
      else assistantMailsByContent.set(content, [e]);
    }
  }

  // Mails hoisted into an earlier text-only turn's slot, tracked by id so the
  // mail's own (possibly late) occurrence is skipped without content-collapsing
  // unrelated duplicates.
  const hoistedMailIds = new Set<string>();
  // mailId → the turnId it replaced. A rating may have been saved against the
  // turnId while the reply rendered as a turn (before its mail arrived); pinning
  // the surviving mail's feedback subject to that turnId keeps the rating from
  // being orphaned when the bubble id flips to the mailId.
  const feedbackTurnIdByMailId = new Map<string, string>();
  const deduped: InstanceEvent[] = [];
  for (const e of events) {
    // A text-only turn echoed by an assistant mail is redundant: emit that
    // server-timestamped mail in the turn's (earliest) slot and drop the turn.
    if (
      e.kind === "turn" &&
      (e.toolCalls?.length ?? 0) === 0 &&
      assistantMailContent.has(e.content.trim())
    ) {
      // If every same-content mail is already hoisted (two identical text-only
      // turns share one mail), the turn collapses with no replacement — matching
      // the prior filter's content-collapse behaviour.
      const mail = assistantMailsByContent
        .get(e.content.trim())
        ?.find((m) => m.kind === "mail" && !hoistedMailIds.has(m.id));
      if (mail !== undefined && mail.kind === "mail") {
        hoistedMailIds.add(mail.id);
        feedbackTurnIdByMailId.set(mail.id, e.turnId);
        deduped.push(mail);
      }
      continue;
    }
    if (e.kind === "mail" && e.role === "assistant") {
      // An assistant mail echoed by a tool-call turn is redundant: keep the turn
      // (it carries the tool narrative).
      if (toolTurnContent.has(e.content.trim())) continue;
      // Already hoisted into an earlier turn's slot — skip this late occurrence.
      if (hoistedMailIds.has(e.id)) continue;
    }
    deduped.push(e);
  }

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
      const feedbackTurnId = feedbackTurnIdByMailId.get(msg.id);
      messages.push(
        feedbackTurnId !== undefined
          ? { ...msg, feedbackId: feedbackTurnId }
          : msg,
      );
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
  const hasLiveImages = liveImages !== undefined && liveImages.length > 0;
  if (liveText !== "" || liveReasoning !== "" || hasLiveImages) {
    const last = messages[messages.length - 1];
    if (last?.role === "agent" && last.content === "") {
      if (liveText !== "") last.content = streaming;
      if (liveReasoning !== "") last.reasoning = reasoning;
      if (hasLiveImages) last.images = [...liveImages!];
      last.status = "sending";
    } else if (liveText !== "") {
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: "agent",
        content: streaming,
        createdAt: new Date().toISOString(),
        status: "sending",
        ...(liveReasoning !== "" ? { reasoning } : {}),
        ...(hasLiveImages ? { images: [...liveImages!] } : {}),
      });
    } else if (liveReasoning !== "" || hasLiveImages) {
      // Reasoning only or images only — agent is thinking/producing output with no text yet.
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: "agent",
        content: "",
        createdAt: new Date().toISOString(),
        status: "sending",
        ...(liveReasoning !== "" ? { reasoning } : {}),
        ...(hasLiveImages ? { images: [...liveImages!] } : {}),
      });
    }
  }

  return { messages };
}
