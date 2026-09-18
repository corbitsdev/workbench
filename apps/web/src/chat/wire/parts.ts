// Mirrored from packages/chat/src (see docs/chat-wire-contract.md).

import { type } from "arktype";

export const TextPart = type({
  kind: "'text'",
  text: "string",
  // Marks the undelivered-turn notice so it renders the failed-turn strip,
  // not a plain bubble.
  "turnFailed?": "boolean",
  // Set with `turnFailed` for a missing/unresolvable model or one that
  // can't use tools, to render named recovery instead of Retry.
  "turnFailedReason?": "'model_unavailable' | 'tools_unsupported'",
  // Marks a user-cancelled turn — distinct from `turnFailed` since
  // cancelling isn't a failure and gets its own copy.
  "turnCancelled?": "boolean",
});
export type TextPart = typeof TextPart.infer;

export const ReasoningPart = type({
  kind: "'reasoning'",
  text: "string",
});
export type ReasoningPart = typeof ReasoningPart.infer;

export const ToolTracePart = type({
  kind: "'tool-trace'",
  name: "string",
  input: "unknown",
  "output?": "unknown",
  status: "'pending' | 'running' | 'success' | 'error'",
});
export type ToolTracePart = typeof ToolTracePart.infer;

export const BlockPart = type({
  kind: "'block'",
  block: {
    type: "string",
    data: "unknown",
  },
});
export type BlockPart = typeof BlockPart.infer;

// Exactly one of `blobId` (already persisted) or `data` (inline base64)
// must be present, unless `artifactId` links this file to a Library row
// instead (see @corbits/artifacts).
export const FilePart = type({
  kind: "'file'",
  name: "string",
  mediaType: "string",
  "blobId?": "string",
  "data?": "string",
  "artifactId?": "string",
}).narrow((part, ctx) => {
  const hasBlobId = part.blobId !== undefined;
  const hasData = part.data !== undefined;
  // An artifact-backed file's bytes live in the Library row, so blobId/data
  // stay optional (still mutually exclusive) once artifactId is set.
  if (part.artifactId !== undefined) {
    if (hasBlobId && hasData) {
      return ctx.reject("`blobId` and `data` cannot both be set on a FilePart");
    }
    return true;
  }
  if (hasBlobId === hasData) {
    return ctx.reject("exactly one of `blobId` or `data` must be set on a FilePart");
  }
  return true;
});
export type FilePart = typeof FilePart.infer;

export const EventPart = type({
  kind: "'event'",
  event: "string",
  data: "unknown",
});
export type EventPart = typeof EventPart.infer;

export const Part = TextPart.or(ReasoningPart)
  .or(ToolTracePart)
  .or(BlockPart)
  .or(FilePart)
  .or(EventPart);
export type Part = typeof Part.infer;

/**
 * Parse untrusted data as a `Part`, throwing a precise error rather than
 * returning malformed or partially-trusted data. The only supported way
 * to bring external JSON into the `Part` type.
 */
export function parsePart(data: unknown): Part {
  const result = Part(data);
  if (result instanceof type.errors) {
    throw new Error(`invalid message part: ${result.summary}`);
  }
  return result;
}
