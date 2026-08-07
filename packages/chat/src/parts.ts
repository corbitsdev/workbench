import { type } from "arktype";

// The wire contract for chat message content. Every message a thread
// carries is a `Part[]`; each part is a structural arktype schema with a
// `kind` discriminant, parsed at the trust boundary rather than cast.

export const TextPart = type({
  kind: "'text'",
  text: "string",
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

// A file rides either as a reference into platform blob storage (`blobId`,
// for content already persisted) or as inline base64 bytes (`data`, for
// content the codec is encoding fresh). Exactly one must be present.
export const FilePart = type({
  kind: "'file'",
  name: "string",
  mediaType: "string",
  "blobId?": "string",
  "data?": "string",
}).narrow((part, ctx) => {
  const hasBlobId = part.blobId !== undefined;
  const hasData = part.data !== undefined;
  if (hasBlobId === hasData) {
    return ctx.reject(
      "exactly one of `blobId` or `data` must be set on a FilePart",
    );
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
    throw new Error(`invalid chat part: ${result.summary}`);
  }
  return result;
}
