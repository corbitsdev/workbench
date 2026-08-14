// Turns a finalized turn's tool-call results into chat `FilePart`s that
// reference a persisted Library artifact (CL-6000). A workflow's
// finalize tool (`pain_point_collateral_finalize`,
// `collateral_generation_finalize`) persists via the sanctioned
// workflow-artifacts HTTP surface (`packages/artifacts-hub`'s
// `createWorkflowArtifactRoutes`) and returns the artifact's id/version
// in its `ToolResult.content` JSON. This module recognizes that shape —
// nothing else — and never fabricates a part for a call it doesn't
// recognize or one that errored.
import { type } from "arktype";

import type { FilePart } from "./parts";

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

function mediaTypeForArtifactKind(kind: string): string {
  return kind === "text" ? "text/plain" : "application/octet-stream";
}

function filePartFor(artifact: {
  id: string;
  title: string;
  kind: string;
}): FilePart {
  return {
    kind: "file",
    name: artifact.title,
    mediaType: mediaTypeForArtifactKind(artifact.kind),
    artifactId: artifact.id,
  };
}

/**
 * Parses one tool call's result for a recognized persisted-artifact
 * shape (single `{id, title, kind, persisted: true}` or batched
 * `{artifacts: [...]}`) and returns the `FilePart`s it names. An
 * errored call, unparseable JSON, or a result that matches neither
 * shape yields no parts — this never guesses.
 */
export function artifactPartsForToolCall(
  toolCall: FinalizedTurnToolCall,
): readonly FilePart[] {
  if (toolCall.isError) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.result);
  } catch {
    return [];
  }

  const single = PersistedArtifactResult(parsed);
  if (!(single instanceof type.errors)) return [filePartFor(single)];

  const batch = PersistedArtifactBatchResult(parsed);
  if (!(batch instanceof type.errors)) {
    return batch.artifacts.map(filePartFor);
  }

  return [];
}

/** Every persisted-artifact `FilePart` across a finalized turn's tool calls. */
export function artifactPartsForFinalizedTurn(
  toolCalls: readonly FinalizedTurnToolCall[],
): readonly FilePart[] {
  return toolCalls.flatMap((call) => artifactPartsForToolCall(call));
}
