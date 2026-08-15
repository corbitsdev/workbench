// Turns a finalized turn's persisted-artifact facts into chat
// `FilePart`s (CL-6000). The recognition itself — which tool-call
// results name a persisted Library artifact — lives in
// `@corbits/turn-artifacts`, shared with every other delivery surface
// (task results included); this module only owns the chat-specific
// half: mapping those facts onto the `FilePart` wire shape chat's
// codec delivers.
import {
  persistedArtifactsForFinalizedTurn,
  persistedArtifactsForToolCall,
  type FinalizedTurnToolCall,
  type PersistedArtifact,
} from "@corbits/turn-artifacts";

import type { FilePart } from "./parts";

function mediaTypeForArtifactKind(kind: string): string {
  return kind === "text" ? "text/plain" : "application/octet-stream";
}

function filePartFor(artifact: PersistedArtifact): FilePart {
  return {
    kind: "file",
    name: artifact.title,
    mediaType: mediaTypeForArtifactKind(artifact.kind),
    artifactId: artifact.id,
  };
}

/** One tool call's persisted artifacts as `FilePart`s. */
export function artifactPartsForToolCall(
  toolCall: FinalizedTurnToolCall,
): readonly FilePart[] {
  return persistedArtifactsForToolCall(toolCall).map(filePartFor);
}

/** Every persisted-artifact `FilePart` across a finalized turn's tool calls. */
export function artifactPartsForFinalizedTurn(
  toolCalls: readonly FinalizedTurnToolCall[],
): readonly FilePart[] {
  return persistedArtifactsForFinalizedTurn(toolCalls).map(filePartFor);
}
