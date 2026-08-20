// A reviewer's reply is model output: untrusted text at a trust
// boundary, parsed with arktype and never asserted into shape. A reply
// that does not parse is not coerced into an empty report — it comes
// back as a named failure so the posted review can say honestly that
// this reviewer did not report, instead of quietly claiming it found
// nothing.
import { type } from "arktype";

const ReviewerFinding = type({
  severity: '"blocking" | "should-fix" | "later"',
  file: "string > 0",
  "line?": "number > 0",
  summary: "string > 0",
  /** The exact lines from the diff a suggestedFix would replace. */
  "existingCode?": "string > 0",
  /** The literal replacement lines — never instructions or prose. */
  "suggestedFix?": "string > 0",
});

const ReviewerReport = type({
  summary: "string",
  findings: ReviewerFinding.array(),
});

export type ReviewerFinding = typeof ReviewerFinding.infer;
export type ReviewerReport = typeof ReviewerReport.infer;

export type ParsedReviewerReport =
  | { readonly ok: true; readonly report: ReviewerReport }
  | { readonly ok: false; readonly reason: string };

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)```$/;

function unwrapFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Parses one reviewer's reply into its report. Tolerates a JSON code
 * fence around the object — models add one often enough that rejecting
 * it would throw away real findings — but nothing beyond that.
 */
export function parseReviewerReport(raw: string): ParsedReviewerReport {
  const body = unwrapFence(raw);
  if (body.length === 0) {
    return { ok: false, reason: "the reply was empty" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return { ok: false, reason: "the reply was not JSON" };
  }
  const parsed = ReviewerReport(decoded);
  if (parsed instanceof type.errors) {
    return { ok: false, reason: parsed.summary };
  }
  return { ok: true, report: parsed };
}
