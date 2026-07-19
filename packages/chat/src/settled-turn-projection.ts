/**
 * Render-time projection: the chat transcript shows OUTPUTS, not process.
 * `composeChatMessages` (packages/agents/src/chat-messages.ts) emits one
 * message per committed segment and stamps every segment of one exchange
 * with a shared `turnId` group key, so a multi-segment turn ("Let me look up
 * X" -> tools -> "Let me check memory" -> final answer) arrives as several
 * agent `ChatMessage`s sharing a group. This module groups by that key and,
 * once every segment has settled, projects the group down to outputs only:
 * the final answer text, any segment carrying an embedded UI block, and any
 * files/attachments produced by ANY segment. Reasoning and tool calls are
 * dropped from the projection entirely — they remain fully available in
 * Insights -> Trace, never in chat.
 *
 * Grouping is by the stamped turn identity, never by adjacency: an
 * agent-initiated mail (gate mail, triage handoff, morning brief) carries no
 * `turnId` and can never be folded into a neighbouring reply. A group
 * containing a failed segment is not projected at all (see
 * `hasFailedSegment`) — the failure carries member-actionable state and must
 * stay visible.
 *
 * This is a RENDER-time concern only. It does not change ordering, dedup, or
 * hoisting in `composeChatMessages` — the composition regression spec that
 * pins one message per committed segment keeps passing unchanged.
 */

import { extractUIBlockFromText } from "@workbench/blocks";
import type { ChatMessage, Part } from "./types";
import { liftToParts } from "./parts";

/**
 * Groups consecutive agent messages that share the same stamped `turnId`.
 * Everything else — non-agent messages, agent messages without a `turnId`
 * (agent-initiated mail), adjacent messages with different ids — is its own
 * single-element group. No merging without an explicit shared identity.
 */
export function groupChatTurns(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    const lastFirst = last?.[0];
    if (
      message.role === "agent" &&
      message.turnId !== undefined &&
      lastFirst?.role === "agent" &&
      lastFirst.turnId === message.turnId
    ) {
      last!.push(message);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

/** True while any segment of the turn is still streaming. */
export function isTurnLive(segments: ChatMessage[]): boolean {
  return segments.some((m) => m.status === "sending");
}

/**
 * True when any segment of the turn failed. A failed segment carries the
 * member-actionable error state ("Failed to send") and must never be
 * silently swallowed by the outputs-only projection — callers render such a
 * group segment-by-segment instead of projecting it.
 */
export function hasFailedSegment(segments: ChatMessage[]): boolean {
  return segments.some((m) => m.status === "failed");
}

/**
 * Strip a segment down to its outputs: content, its own files/attachments/
 * images (plus any carried in from dropped sibling segments), and none of
 * the process fields (`reasoning`, `toolCalls`, tool/reasoning parts).
 */
function projectOutputs(
  segment: ChatMessage,
  carriedFrom: ChatMessage[],
): ChatMessage {
  const sources = [...carriedFrom, segment];
  const fileParts: Part[] = sources.flatMap((m) =>
    (m.parts ?? liftToParts(m)).filter((part) => part.type === "file"),
  );
  const attachments = sources.flatMap((m) => m.attachments ?? []);
  const images = sources.flatMap((m) => m.images ?? []);

  const {
    reasoning: _reasoning,
    toolCalls: _toolCalls,
    parts: _parts,
    attachments: _attachments,
    images: _images,
    ...rest
  } = segment;

  const textPart: Part[] =
    segment.content.trim() !== ""
      ? [{ type: "text", text: segment.content }]
      : [];

  return {
    ...rest,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(images.length > 0 ? { images } : {}),
    parts: [...fileParts, ...textPart],
  };
}

/**
 * True when a projected segment carries something the transcript actually
 * renders — answer/UI-block text, a produced file, or an inline image/
 * attachment. A settled segment that projects to pure emptiness (a
 * reasoning-only "thinking" step that committed no answer) renders no bubble
 * and no activity block, so keeping it would only leave an orphan turn slot —
 * its inter-turn gaps and hover-only feedback footer showing up as a large
 * vertical whitespace gap above the streaming answer (CL-3752).
 */
function hasRenderableOutput(segment: ChatMessage): boolean {
  if (segment.content.trim() !== "") return true;
  const parts = segment.parts ?? liftToParts(segment);
  if (parts.some((part) => part.type === "file" || part.type === "text")) {
    return true;
  }
  if ((segment.images?.length ?? 0) > 0) return true;
  if ((segment.attachments?.length ?? 0) > 0) return true;
  return false;
}

/**
 * True when a segment carries an output the transcript must preserve even when
 * it is not the final line: an embedded UI block (a product), a produced file,
 * or an inline image/attachment. Pure-text narration has none of these and is
 * treated as interstitial process during the live-phase collapse.
 */
function hasNonNarrationOutput(segment: ChatMessage): boolean {
  if (extractUIBlockFromText(segment.content) !== null) return true;
  const parts = segment.parts ?? liftToParts(segment);
  if (parts.some((part) => part.type === "file")) return true;
  if ((segment.images?.length ?? 0) > 0) return true;
  if ((segment.attachments?.length ?? 0) > 0) return true;
  return false;
}

/**
 * Live-phase projection (CL-3734, CL-3948): apply the outputs-only rule to
 * every segment that has ALREADY settled within a still-live group, so process
 * rows disappear the moment a segment commits rather than waiting for the whole
 * turn to end. The segment(s) still `status: "sending"` are left untouched —
 * each keeps its parts intact so `AgentTurn` renders its rolling activity line.
 *
 * Among the settled segments this mirrors `projectSettledTurn`'s
 * interstitial-collapse rule: only the FINAL settled text segment survives,
 * plus any settled segment carrying real output (UI block / file / attachment /
 * image). Earlier settled pure-narration segments — the "Let me check…/Let me
 * look up…" lines — are dropped. This matters while a turn is parked on a
 * native approval gate: the turn never settles, so without this collapse every
 * interstitial narration line would linger above the pending action
 * (CL-3948). A settled segment that projects to no output at all is dropped
 * too (CL-3752). When the last segment settles, the caller switches to
 * `projectSettledTurn`, which re-derives the merged final answer — so the
 * transcript re-projects to the same result a reload would produce.
 */
export function projectLiveTurn(segments: ChatMessage[]): ChatMessage[] {
  const finalSettledText = [...segments]
    .reverse()
    .find((m) => m.status !== "sending" && m.content.trim() !== "");
  return segments.flatMap((segment) => {
    if (segment.status === "sending") return [segment];
    const projected = projectOutputs(segment, []);
    if (!hasRenderableOutput(projected)) return [];
    if (segment === finalSettledText || hasNonNarrationOutput(segment)) {
      return [projected];
    }
    return [];
  });
}

/**
 * Collapse a settled multi-segment agent turn into its outputs-only
 * messages, in original segment order:
 *
 *   - every non-final segment carrying an embedded fenced ```ui block keeps
 *     its own entry (blocks are products, not process) — projected, so its
 *     tool/reasoning data is still dropped;
 *   - the final answer: the last segment with non-empty text (falling back
 *     to the last segment so files/feedback still anchor somewhere), which
 *     additionally absorbs the files/attachments/images of every DROPPED
 *     segment so no produced file is lost.
 *
 * Interstitial narration segments without a block simply disappear.
 */
export function projectSettledTurn(segments: ChatMessage[]): ChatMessage[] {
  const lastSegment = segments[segments.length - 1]!;
  const finalSegment =
    [...segments].reverse().find((m) => m.content.trim() !== "") ?? lastSegment;

  const blockSegments = segments.filter(
    (m) => m !== finalSegment && extractUIBlockFromText(m.content) !== null,
  );
  const dropped = segments.filter(
    (m) => m !== finalSegment && !blockSegments.includes(m),
  );

  return [
    ...blockSegments.map((segment) => projectOutputs(segment, [])),
    projectOutputs(finalSegment, dropped),
  ];
}
