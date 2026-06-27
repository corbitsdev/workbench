import { type } from "arktype";
import { Markdown } from "./Markdown";

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

function rankForLabel(
  ranking: readonly ComparisonRankingEntry[],
  label: string,
): ComparisonRankingEntry | undefined {
  return ranking.find((entry) => entry.label === label);
}

// Order variants by their rank (winner first); variants the ranking never
// mentions sort to the end in their original order.
function orderVariantsByRank(
  variants: readonly ComparisonVariant[],
  ranking: readonly ComparisonRankingEntry[],
): ComparisonVariant[] {
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  return [...variants].sort((a, b) => {
    const ra = rankForLabel(ranking, a.label)?.rank ?? UNRANKED;
    const rb = rankForLabel(ranking, b.label)?.rank ?? UNRANKED;
    return ra - rb;
  });
}

function Ordinal({ rank, winner }: { rank: number; winner: boolean }) {
  // Breakthrough Orange is earned, not distributed: only the winner's ordinal
  // carries the accent; every other rank is a neutral chip. Space Mono +
  // tabular-nums treats the rank as a data readout (matches ResearchBody).
  const tone = winner
    ? "bg-orange text-white"
    : "bg-surface-2 border border-border text-text-2";
  return (
    <span
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-mono text-xs tabular-nums ${tone}`}
    >
      {rank}
    </span>
  );
}

function RankingSection({ result }: { result: ComparisonResult }) {
  if (result.ranking.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-text">Ranking</h2>
      <ol className="space-y-2">
        {result.ranking.map((entry, index) => {
          const winner = entry.rank === 1;
          return (
            <li
              key={index}
              className={`flex gap-3 rounded-lg border p-3 ${
                winner
                  ? "border-orange bg-orange/8"
                  : "border-border bg-surface-2"
              }`}
            >
              <Ordinal rank={entry.rank} winner={winner} />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-text">{entry.label}</p>
                {entry.rationale !== undefined && (
                  <p className="text-sm text-text-2 leading-relaxed text-pretty">
                    {entry.rationale}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function VariantCard({
  variant,
  rank,
  blind,
}: {
  variant: ComparisonVariant;
  rank: ComparisonRankingEntry | undefined;
  blind: boolean;
}) {
  const winner = rank?.rank === 1;
  // In a blind review the provider/model stays hidden so the reviewer judges
  // the output, not the brand; the saved artifact reveals it.
  const meta = blind
    ? ""
    : [variant.providerName, variant.model]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border p-4 ${
        winner ? "border-orange bg-orange/8" : "border-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-text">{variant.label}</p>
          {meta.length > 0 && (
            <p className="font-mono text-[11px] text-text-3 tabular-nums">
              {meta}
            </p>
          )}
        </div>
        {rank !== undefined && <Ordinal rank={rank.rank} winner={winner} />}
      </div>
      <div className="text-sm text-text-2 leading-relaxed">
        <Markdown>{variant.content}</Markdown>
      </div>
    </div>
  );
}

function VariantsSection({
  result,
  blind,
}: {
  result: ComparisonResult;
  blind: boolean;
}) {
  const withContent = result.variants.filter(
    (variant) => variant.content.trim().length > 0,
  );
  if (withContent.length === 0) return null;
  const ordered = orderVariantsByRank(withContent, result.ranking);
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-text">Variants</h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {ordered.map((variant, index) => (
          <VariantCard
            key={index}
            variant={variant}
            rank={rankForLabel(result.ranking, variant.label)}
            blind={blind}
          />
        ))}
      </div>
    </section>
  );
}

export interface ComparisonViewProps {
  result: ComparisonResult;
  /**
   * Hide each variant's provider/model identity. Use during a blind review so
   * the reviewer is not biased by the brand; the saved artifact renders with
   * `blind` off so the identities are revealed. Defaults to false (revealed).
   */
  blind?: boolean;
}

/**
 * Render an A/B comparison result: a lead summary, the ranking (winner
 * accented), the recommendation as a labeled conclusion, and the variant
 * outputs side by side. Shared by the artifact renderer and the workflow
 * panels so the saved artifact looks exactly like the in-flight review.
 */
export function ComparisonView({ result, blind = false }: ComparisonViewProps) {
  return (
    <div className="space-y-7">
      {result.summary !== undefined && (
        <p className="text-base text-text leading-relaxed text-pretty">
          {result.summary}
        </p>
      )}

      <RankingSection result={result} />

      {result.recommendation !== undefined && (
        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="text-sm font-semibold text-text">Recommendation</h2>
          <p className="text-sm font-medium text-text leading-relaxed text-pretty">
            {result.recommendation}
          </p>
        </section>
      )}

      <VariantsSection result={result} blind={blind} />
    </div>
  );
}
