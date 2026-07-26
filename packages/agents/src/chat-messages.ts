import type { InstanceEvent } from "@intx/hub-client";

type TurnEvent = Extract<InstanceEvent, { kind: "turn" }>;
import { turnToEvent } from "@intx/hub-client";
import type { InferenceTurnResponse } from "@intx/types";
import type { ChatMessage, ChatImage, Part } from "@workbench/agent-core/parts";
import { liftToParts } from "@workbench/agent-core/parts";
import { convertInstanceEvents } from "./adapter";

export const STREAMING_BUBBLE_ID = "streaming-synthetic";

/**
 * Compensate for a gap in @intx/hub-client's `turnToEvent` (see
 * interchange/packages/hub-client/src/transforms.ts): it drops any
 * historical turn that carries no errors and no tool calls, on the
 * assumption the turn's text survives via an echoed outbound assistant
 * mail. That assumption held while the harness always sent that echo mail.
 * Under the current workflow-host runtime, single-step deployments no
 * longer send it, so for a plain-text turn the persisted `inference_turn`
 * is the ONLY record of the assistant's reply — and `turnToEvent` silently
 * drops it, leaving nothing to render on reload.
 *
 * This mirrors turnToEvent's own text-extraction exactly (same parts
 * filter, same join, same timestamp source) so the reconstructed event is
 * indistinguishable from what turnToEvent would have produced had it not
 * dropped the turn — it hoists against a matching echo mail exactly like a
 * turn that survived the transform, and dedupes the same way. Only fills
 * the gap turnToEvent leaves (no errors, no tool calls, non-empty text);
 * every turn turnToEvent already converts is left untouched.
 *
 * This is a workbench-side compensation for an upstream gap, not a
 * permanent feature: delete it once the interchange pin carries the
 * one-line fix (dropping a turn only when it ALSO has no text).
 */
export function reconstructDroppedTurnEvents(
  turns: readonly InferenceTurnResponse[],
): InstanceEvent[] {
  const reconstructed: InstanceEvent[] = [];
  for (const turn of turns) {
    if (turnToEvent(turn) !== null) continue;
    const rawContent = turn.parts
      .filter(
        (p): p is typeof p & { content: string } =>
          p.type === "text" &&
          typeof p.content === "string" &&
          p.content.length > 0,
      )
      .map((p) => p.content)
      .join("");
    if (rawContent.length === 0) continue;
    reconstructed.push({
      kind: "turn",
      turnId: turn.id,
      content: rawContent,
      timestamp: turn.startedAt,
    });
  }
  return reconstructed;
}

/**
 * Merge reconstructed turn events (see `reconstructDroppedTurnEvents`) into
 * a hydrated event list, skipping any turnId the list already carries — a
 * turn `turnToEvent` did NOT drop (it had errors or tool calls) is already
 * present and must not be duplicated. Re-sorts by server timestamp only
 * when an event was actually added, matching @intx/hub-client's own
 * hydration sort so a reconstructed turn lands in its chronological slot
 * rather than always at the tail.
 */
export function mergeReconstructedTurns(
  events: readonly InstanceEvent[],
  reconstructed: readonly InstanceEvent[],
): InstanceEvent[] {
  const isTurn = (e: InstanceEvent): e is TurnEvent => e.kind === "turn";
  const existingTurnIds = new Set(events.filter(isTurn).map((e) => e.turnId));
  const toAdd = reconstructed.filter(
    (e) => !isTurn(e) || !existingTurnIds.has(e.turnId),
  );
  if (toAdd.length === 0) return [...events];
  return [...events, ...toAdd].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

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
  /**
   * Ordered parts for the turn currently streaming, from the part-assembler.
   * Attached to the synthesized/overwritten trailing live bubble only —
   * committed messages get their `parts` from `liftToParts` instead.
   */
  liveParts?: readonly Part[];
}

export interface ComposeChatResult {
  messages: ChatMessage[];
}

function normalizeAssistantText(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
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
  const {
    events,
    streaming,
    toolNames,
    reasoning = "",
    liveImages,
    liveParts,
  } = input;

  // Content of assistant mail (server-timestamped) and of turns that carry tool
  // calls (the only thing mail cannot represent).
  const assistantMailContent = new Set(
    events
      .filter((e) => e.kind === "mail" && e.role === "assistant")
      .map((e) => normalizeAssistantText(e.content)),
  );
  const toolTurnContent = new Set(
    events
      .filter((e) => e.kind === "turn" && (e.toolCalls?.length ?? 0) > 0)
      .map((e) => normalizeAssistantText(e.content)),
  );
  // Assistant mails grouped by content, in arrival order. A text-only turn is
  // matched to the next not-yet-hoisted mail of the same content so distinct
  // replies that happen to share identical text are not collapsed together.
  const assistantMailsByContent = new Map<string, InstanceEvent[]>();
  for (const e of events) {
    if (e.kind === "mail" && e.role === "assistant") {
      const content = normalizeAssistantText(e.content);
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
  /** Reasoning (and trace) from a dropped turn, keyed by hoisted mail id. */
  const deduped: InstanceEvent[] = [];
  for (const e of events) {
    // A text-only turn echoed by an assistant mail is redundant: emit that
    // server-timestamped mail in the turn's (earliest) slot and drop the turn.
    if (
      e.kind === "turn" &&
      (e.toolCalls?.length ?? 0) === 0 &&
      assistantMailContent.has(normalizeAssistantText(e.content))
    ) {
      // If every same-content mail is already hoisted (two identical text-only
      // turns share one mail), the turn collapses with no replacement — matching
      // the prior filter's content-collapse behaviour.
      const mail = assistantMailsByContent
        .get(normalizeAssistantText(e.content))
        ?.find((m) => m.kind === "mail" && !hoistedMailIds.has(m.id));
      if (mail !== undefined && mail.kind === "mail") {
        hoistedMailIds.add(mail.id);
        feedbackTurnIdByMailId.set(mail.id, e.turnId);
        // Reloaded turns no longer carry a `reasoning` trace: upstream dropped
        // it from the hub-client `InstanceEvent` turn variant with the session
        // runtime retirement. Live reasoning still renders via the streaming
        // path; hoisted-mail traces from history are simply absent now.
        deduped.push(mail);
      }
      continue;
    }
    if (e.kind === "mail" && e.role === "assistant") {
      // An assistant mail echoed by a tool-call turn is redundant: keep the turn
      // (it carries the tool narrative).
      if (toolTurnContent.has(normalizeAssistantText(e.content))) continue;
      // Already hoisted into an earlier turn's slot — skip this late occurrence.
      if (hoistedMailIds.has(e.id)) continue;
    }
    deduped.push(e);
  }

  const converted = convertInstanceEvents(deduped, toolNames);

  // Turn-group identity for the renderer. Committed segments of one exchange
  // carry DISTINCT transport turnIds (each segment commits as its own turn
  // event — pinned by the composition regression spec), so the only real
  // exchange boundary is an inbound user mail. Stamp every turn-derived
  // message (and any assistant mail hoisted into a turn's slot) with the
  // current exchange's group key; standalone assistant mails (gate mail,
  // triage handoffs, briefs) get NO group key so the renderer can never fold
  // them into a neighbouring reply. Additive only — ordering, dedup, and
  // hoisting semantics above are untouched.
  let exchangeIndex = 0;
  const groupIds = deduped.map((e): string | undefined => {
    if (e.kind === "mail" && e.role === "user") {
      exchangeIndex += 1;
      return undefined;
    }
    if (e.kind === "turn") return `exchange-${exchangeIndex}`;
    if (hoistedMailIds.has(e.id)) return `exchange-${exchangeIndex}`;
    return undefined;
  });
  const liveGroupId = `exchange-${exchangeIndex}`;

  // Deduplicate by message id. The session layer already deduplicates events
  // by id, but guard here too in case two different code paths produce the
  // same id (e.g. a hydration race that drains the SSE buffer after the REST
  // fetch returns the same mail).
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const [index, msg] of converted.entries()) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id);
      const feedbackTurnId = feedbackTurnIdByMailId.get(msg.id);
      const groupId = groupIds[index];
      const withFeedback =
        feedbackTurnId !== undefined
          ? { ...msg, feedbackId: feedbackTurnId }
          : msg;
      const withGroup: ChatMessage =
        groupId !== undefined
          ? { ...withFeedback, turnId: groupId }
          : withFeedback;
      messages.push({ ...withGroup, parts: liftToParts(withGroup) });
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
  // it from createPartAssembler, which reads each delta's per-turn cumulative
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
  // The final segment of the current turn can commit its text while the live
  // streaming buffer still holds that same text — the turn is parked on a
  // native approval gate and never reset the buffer. The trailing committed
  // bubble then already shows the final line; synthesizing a streaming bubble
  // would render it twice, and the STREAMING_BUBBLE_ID dedupe can't catch it
  // (the committed bubble carries its own id). Suppress on NORMALIZED-equal
  // content only, so a genuine continuation with different text still streams
  // as its own bubble (CL-3948). The empty-commit overwrite path (CL-1398 /
  // CL-1643) is unaffected — an empty trailing bubble never matches non-empty
  // live text.
  const trailing = messages[messages.length - 1];
  const trailingDuplicatesLiveText =
    trailing?.role === "agent" &&
    trailing.turnId === liveGroupId &&
    liveText !== "" &&
    trailing.content !== "" &&
    normalizeAssistantText(trailing.content) ===
      normalizeAssistantText(streaming);
  if (
    (liveText !== "" || liveReasoning !== "" || hasLiveImages) &&
    !trailingDuplicatesLiveText
  ) {
    const last = messages[messages.length - 1];
    if (last?.role === "agent" && last.content === "") {
      if (liveText !== "") last.content = streaming;
      if (liveReasoning !== "") last.reasoning = reasoning;
      if (hasLiveImages) last.images = [...liveImages!];
      if (liveParts !== undefined) last.parts = [...liveParts];
      last.status = "sending";
    } else if (liveText !== "") {
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: "agent",
        content: streaming,
        createdAt: new Date().toISOString(),
        status: "sending",
        // Same exchange group as the turn's already-committed segments, so
        // the renderer treats the whole in-flight turn as one live group.
        turnId: liveGroupId,
        ...(liveReasoning !== "" ? { reasoning } : {}),
        ...(hasLiveImages ? { images: [...liveImages!] } : {}),
        ...(liveParts !== undefined ? { parts: [...liveParts] } : {}),
      });
    } else if (liveReasoning !== "" || hasLiveImages) {
      // Reasoning only or images only — agent is thinking/producing output with no text yet.
      messages.push({
        id: STREAMING_BUBBLE_ID,
        role: "agent",
        content: "",
        createdAt: new Date().toISOString(),
        status: "sending",
        turnId: liveGroupId,
        ...(liveReasoning !== "" ? { reasoning } : {}),
        ...(hasLiveImages ? { images: [...liveImages!] } : {}),
        ...(liveParts !== undefined ? { parts: [...liveParts] } : {}),
      });
    }
  }

  return { messages };
}
