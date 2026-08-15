// Recognizes a persisted Library artifact in a finalized turn's
// tool-call results (CL-6000). A workflow's finalize tool persists via
// the sanctioned workflow-artifacts HTTP surface
// (`packages/artifacts-hub`'s `createWorkflowArtifactRoutes`) and
// returns the artifact's id/version in its `ToolResult.content` JSON.
// This module recognizes that shape — nothing else — and never
// fabricates an artifact for a call it doesn't recognize or one that
// errored. Lifted out of `@corbits/chat` so every delivery surface
// (chat messages, task results) reads the same facts without a
// dependency on chat itself.
import { type } from "arktype";

/**
 * The minimal shape this module reads off a finalized turn. Deliberately
 * structural rather than importing `@intx/hub-sessions`' `TurnFinalized`/
 * `TurnToolCall` (which that vendored package does not export past its
 * own internal module) — every real `TurnToolCall` satisfies this.
 */
export type FinalizedTurnToolCall = {
  readonly result: string;
  readonly isError: boolean;
};

const PersistedArtifactResult = type({
  id: "string > 0",
  title: "string > 0",
  kind: "string > 0",
  persisted: "true",
});

const PersistedArtifactBatchResult = type({
  artifacts: PersistedArtifactResult.array(),
});

/** A recognized persisted-artifact result, parsed off one finalized tool call. */
export type PersistedArtifact = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
};

/**
 * Parses one tool call's result for a recognized persisted-artifact
 * shape (single `{id, title, kind, persisted: true}` or batched
 * `{artifacts: [...]}`) and returns the artifacts it names. An errored
 * call, unparseable JSON, or a result that matches neither shape yields
 * nothing — this never guesses.
 */
export function persistedArtifactsForToolCall(
  toolCall: FinalizedTurnToolCall,
): readonly PersistedArtifact[] {
  if (toolCall.isError) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.result);
  } catch {
    return [];
  }

  const single = PersistedArtifactResult(parsed);
  if (!(single instanceof type.errors)) return [single];

  const batch = PersistedArtifactBatchResult(parsed);
  if (!(batch instanceof type.errors)) return batch.artifacts;

  return [];
}

/** Every persisted artifact named across a finalized turn's tool calls. */
export function persistedArtifactsForFinalizedTurn(
  toolCalls: readonly FinalizedTurnToolCall[],
): readonly PersistedArtifact[] {
  return toolCalls.flatMap((call) => persistedArtifactsForToolCall(call));
}
