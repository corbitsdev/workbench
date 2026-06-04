import { type Severity } from '@workbench/shared';

/**
 * Where a transcript originated. Mirrors the intake paths the workbench
 * supports: a pasted blob or a Granola import.
 */
export type TranscriptSource = 'paste' | 'granola';

/**
 * The role a speaker plays in a call. `rep` is the internal sales rep,
 * `prospect` is the customer, and `unknown` covers diarization gaps.
 */
export type SpeakerRole = 'rep' | 'prospect' | 'unknown';

/**
 * A single participant in the call. Identity is stable across the turns
 * they speak so the UI can colour-code or group by speaker.
 */
export interface TranscriptSpeaker {
  id: string;
  name: string;
  role: SpeakerRole;
}

/**
 * One contiguous chunk of speech attributed to a single speaker. Turns are
 * the renderable unit of a structured transcript.
 */
export interface TranscriptTurn {
  id: string;
  speakerId: string;
  text: string;
  /** Offset from the start of the call, in seconds. */
  startSeconds?: number;
}

/**
 * Provenance and company context for a transcript. Surfaced as a header so
 * the human reviewer always knows which call they are looking at.
 */
export interface TranscriptMetadata {
  source: TranscriptSource;
  companyName?: string;
  /** Display title for the call, e.g. "Acme — Discovery". */
  title?: string;
  /** ISO 8601 timestamp of when the call took place. */
  recordedAt?: string;
}

/**
 * A fully structured transcript: ordered turns plus the speakers they
 * reference and the call's provenance.
 */
export interface StructuredTranscript {
  speakers: TranscriptSpeaker[];
  turns: TranscriptTurn[];
  metadata: TranscriptMetadata;
}

/**
 * A pain point the reviewer has selected, projected into the transcript view
 * so its supporting quote can be highlighted in context. Intentionally a
 * thin slice of the shared `PainPoint` model — the package never owns
 * workflow state.
 */
export interface SelectedPainPointContext {
  id: string;
  severity: Severity;
  context: string;
  /** The verbatim quote drawn from the transcript. */
  quote: string;
}
