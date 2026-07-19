// Derives the suspended (approval-awaiting) tool call from a chat thread's
// transcript (CL-3940). The native approval rail drops the backend tool
// snapshot in the runtime, so the card sources the action + args from the
// open thread's own turns instead: a tool "call" part whose callId has no
// matching tool "result" part is a call still awaiting a result — i.e. the
// suspended write the approval is gating. The exactly-one guard below is a
// hard no-mismatch guarantee: with zero or more than one unresolved call the
// card cannot know which pending approval maps to which call, so it falls back
// to a neutral label rather than showing a guessed action.

import { type } from "arktype";

// A minimal boundary schema for the `/turns` response — only the fields this
// derivation reads. The full `InferenceTurnResponse` shape lives in `@intx/types`
// (not an apps/web runtime dependency); parsing the narrow slice here keeps the
// module self-contained while still validating the payload at the trust boundary.
export const ThreadTurnSchema = type({
  parts: type({
    type: "string",
    "metadata?": "Record<string, unknown> | null",
  }).array(),
});
export type ThreadTurn = typeof ThreadTurnSchema.infer;

const ThreadTurnsResponseSchema = type({
  data: ThreadTurnSchema.array(),
});

export type UnresolvedToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Parse the `/turns` list response at the trust boundary. Throws on a malformed
 * payload so a bad shape surfaces rather than silently producing an empty list.
 */
export function parseThreadTurns(raw: unknown): ThreadTurn[] {
  const parsed = ThreadTurnsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid thread turns response: ${parsed.summary}`);
  }
  return parsed.data;
}

function asArgumentRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * The tool calls in the thread that have no matching tool result — the calls
 * still suspended awaiting resolution. Calls are deduped by callId (a streamed
 * call part can be re-emitted) so a single call never counts as two.
 */
export function findUnresolvedToolCalls(
  turns: ThreadTurn[],
): UnresolvedToolCall[] {
  const callsById = new Map<string, UnresolvedToolCall>();
  const resolvedCallIds = new Set<string>();

  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== "tool") continue;
      const metadata = part.metadata;
      if (metadata === null || metadata === undefined) continue;
      const callId = metadata["callId"];
      if (typeof callId !== "string" || callId.length === 0) continue;

      if (metadata["kind"] === "call") {
        const name = metadata["name"];
        if (typeof name !== "string" || name.length === 0) continue;
        callsById.set(callId, {
          callId,
          name,
          arguments: asArgumentRecord(metadata["arguments"]),
        });
      } else if (metadata["kind"] === "result") {
        resolvedCallIds.add(callId);
      }
    }
  }

  return [...callsById.values()].filter(
    (call) => !resolvedCallIds.has(call.callId),
  );
}

/**
 * The single unresolved tool call in the thread, or null when there are zero or
 * more than one. The card only trusts the transcript-derived action when there
 * is exactly one candidate — the no-mismatch guarantee.
 */
export function singleUnresolvedToolCall(
  turns: ThreadTurn[],
): UnresolvedToolCall | null {
  const unresolved = findUnresolvedToolCalls(turns);
  return unresolved.length === 1 ? (unresolved[0] ?? null) : null;
}
