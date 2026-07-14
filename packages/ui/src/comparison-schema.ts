import { type } from "arktype";

// The persisted A/B comparison artifact payload — the single source of truth
// shared by the compose tool (producer), the artifact renderer, and the
// workflow panels (consumers). The artifact `content` is the JSON string of a
// `ComparisonResult`; the renderer parses it back through this schema.

export const ComparisonRankingEntrySchema = type({
  rank: "number",
  label: "string",
  "rationale?": "string",
});
export type ComparisonRankingEntry = typeof ComparisonRankingEntrySchema.infer;

export const ComparisonVariantSchema = type({
  label: "string",
  "providerName?": "string",
  "model?": "string",
  // Per-variant lifecycle for the unified live+final grid: a lane not
  // yet terminal is "streaming" (calm placeholder that keeps its slot), a
  // terminal non-empty lane is "responded", and a terminal empty/errored lane is
  // "no-response" (a gold marker, never dropped). Absent on saved artifacts
  // (always final + fully responded), so they render exactly as before.
  "status?": "'streaming' | 'responded' | 'no-response'",
  // A humanized model name (e.g. "Claude Opus") rendered in place of the raw
  // provider/model ids when present. Producing that humanized string is a
  // separate concern; this renderer only displays it when given, and never
  // formats raw ids into it.
  "meta?": "string",
  content: "string",
});
export type ComparisonVariant = typeof ComparisonVariantSchema.infer;

export const ComparisonResultSchema = type({
  "summary?": "string",
  "recommendation?": "string",
  // Who decided the winner: an agent judge ("agent") or the human ("human").
  // Optional so older artifacts (no decider recorded) still parse.
  "decidedBy?": "'agent' | 'human'",
  ranking: ComparisonRankingEntrySchema.array(),
  variants: ComparisonVariantSchema.array(),
});
export type ComparisonResult = typeof ComparisonResultSchema.infer;

/**
 * Parse an unknown value (a JSON string, as stored in `artifact.content`, or an
 * already-decoded object) into a `ComparisonResult`. Returns null when the
 * value is absent or does not match the schema, so callers can fall back to a
 * plain renderer rather than throwing on a malformed payload.
 */
export function parseComparisonResult(value: unknown): ComparisonResult | null {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (decoded === undefined || decoded === null) return null;
  const parsed = ComparisonResultSchema(decoded);
  if (parsed instanceof type.errors) return null;
  return parsed;
}