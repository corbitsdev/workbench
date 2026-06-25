import { type } from "arktype";

/**
 * Where a transcript originated. Mirrors the intake paths the workbench
 * supports: a pasted blob or a Granola import.
 */
export const TranscriptSource = type("'paste' | 'granola'");
export type TranscriptSource = typeof TranscriptSource.infer;

/**
 * The role a speaker plays in a call. `rep` is the internal sales rep,
 * `prospect` is the customer, and `unknown` covers diarization gaps.
 */
export const SpeakerRole = type("'rep' | 'prospect' | 'unknown'");
export type SpeakerRole = typeof SpeakerRole.infer;

/**
 * A single participant in the call. Identity is stable across the turns
 * they speak so the UI can colour-code or group by speaker.
 */
export const TranscriptSpeaker = type({
  id: "string",
  name: "string",
  role: SpeakerRole,
});
export type TranscriptSpeaker = typeof TranscriptSpeaker.infer;

/**
 * One contiguous chunk of speech attributed to a single speaker. Turns are
 * the renderable unit of a structured transcript.
 */
export const TranscriptTurn = type({
  id: "string",
  speakerId: "string",
  text: "string",
  /** Offset from the start of the call, in seconds. */
  "startSeconds?": "number",
});
export type TranscriptTurn = typeof TranscriptTurn.infer;

/**
 * Provenance and company context for a transcript. Surfaced as a header so
 * the human reviewer always knows which call they are looking at.
 */
export const TranscriptMetadata = type({
  source: TranscriptSource,
  "companyName?": "string",
  /** Display title for the call, e.g. "Acme — Discovery". */
  "title?": "string",
  /** ISO 8601 timestamp of when the call took place. */
  "recordedAt?": "string",
});
export type TranscriptMetadata = typeof TranscriptMetadata.infer;

/**
 * A fully structured transcript: ordered turns plus the speakers they
 * reference and the call's provenance.
 */
export const StructuredTranscript = type({
  speakers: TranscriptSpeaker.array(),
  turns: TranscriptTurn.array(),
  metadata: TranscriptMetadata,
});
export type StructuredTranscript = typeof StructuredTranscript.infer;

/**
 * A pain point the reviewer has selected, projected into the transcript view
 * so its supporting quote can be highlighted in context. Intentionally a
 * thin slice of the shared `PainPoint` model — the package never owns
 * workflow state. `severity` mirrors the shared `Severity` union.
 */
export const SelectedPainPointContext = type({
  id: "string",
  severity: "'low' | 'medium' | 'high' | 'critical'",
  context: "string",
  /** The verbatim quote drawn from the transcript. */
  quote: "string",
});
export type SelectedPainPointContext = typeof SelectedPainPointContext.infer;

/**
 * Validate an untrusted value as a {@link StructuredTranscript}, throwing on
 * mismatch. Use at deserialize / public-API boundaries where the transcript
 * arrives from outside this package (parsed payloads, persisted records).
 */
export function parseStructuredTranscript(value: unknown): StructuredTranscript {
  const parsed = StructuredTranscript(value);
  if (parsed instanceof type.errors) {
    throw new Error(`StructuredTranscript: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * Validate an untrusted value as a {@link SelectedPainPointContext}, throwing
 * on mismatch. Use at the public-API boundary where pain-point context is
 * projected into the transcript view from outside this package.
 */
export function parseSelectedPainPointContext(
  value: unknown,
): SelectedPainPointContext {
  const parsed = SelectedPainPointContext(value);
  if (parsed instanceof type.errors) {
    throw new Error(`SelectedPainPointContext: ${parsed.summary}`);
  }
  return parsed;
}
