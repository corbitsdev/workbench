import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Markdown } from "./Markdown";
import type {
  ComparisonRankingEntry,
  ComparisonResult,
  ComparisonVariant,
} from "./comparison-schema";
import {
  crossfadePresence,
  motionPropsWhen,
  staggerItemTransition,
} from "./motion";

export {
  ComparisonRankingEntrySchema,
  ComparisonResultSchema,
  ComparisonVariantSchema,
  parseComparisonResult,
  type ComparisonRankingEntry,
  type ComparisonResult,
  type ComparisonVariant,
} from "./comparison-schema";

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

function variantStatus(
  variant: ComparisonVariant,
): "streaming" | "responded" | "no-response" {
  return variant.status ?? "responded";
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

// A calm, in-place spinner for a lane still producing its answer — never a
// skeleton that reflows when content lands. Honors reduced-motion via CSS.
function StreamingCell() {
  return (
    <div className="flex items-center gap-2 text-sm text-text-3">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-orange motion-reduce:animate-none"
      />
      <span>Working…</span>
    </div>
  );
}

// A lane that finished without an answer keeps its slot with a gold marker
// rather than vanishing — the grid stays stable and the absence is legible.
function NoResponseCell() {
  return <p className="text-sm font-medium text-orange">No response</p>;
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

function variantMeta(variant: ComparisonVariant, blind: boolean): string {
  // In a blind review the provider/model stays hidden so the reviewer judges
  // the output, not the brand; the saved artifact reveals it.
  if (blind) return "";
  if (variant.meta !== undefined && variant.meta.length > 0)
    return variant.meta;
  return [variant.providerName, variant.model]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function VariantCard({
  variant,
  rank,
  blind,
  running,
}: {
  variant: ComparisonVariant;
  rank: ComparisonRankingEntry | undefined;
  blind: boolean;
  // While the run is still executing, the winner accent and ordinals are
  // suppressed — nothing has been decided, so no cell may claim the accent.
  running: boolean;
}) {
  const status = variantStatus(variant);
  const winner = !running && rank?.rank === 1;
  const showOrdinal = !running && rank !== undefined;
  const meta = variantMeta(variant, blind);
  let tone = "border-border bg-surface-2";
  if (winner) {
    tone = "border-orange bg-orange/8";
  } else if (status === "no-response") {
    tone = "border-border border-dashed bg-surface-2";
  }
  return (
    <div
      data-testid="comparison-variant"
      data-label={variant.label}
      data-status={status}
      data-winner={String(winner)}
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors duration-300 motion-reduce:transition-none ${tone}`}
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
        {showOrdinal && rank !== undefined && (
          <Ordinal rank={rank.rank} winner={winner} />
        )}
      </div>
      {status === "streaming" && <StreamingCell />}
      {status === "no-response" && <NoResponseCell />}
      {status === "responded" && (
        <div className="text-sm text-text-2 leading-relaxed">
          <Markdown>{variant.content}</Markdown>
        </div>
      )}
    </div>
  );
}

// The calm survivor count — the ONLY count the grid surfaces. It reports how
// many lanes responded, never an alarming "N failed" tally (house rule).
function RespondedPill({
  responded,
  total,
}: {
  responded: number;
  total: number;
}) {
  return (
    <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-text-2 tabular-nums">
      {responded} of {total} responded
    </span>
  );
}

function VariantsSection({
  result,
  blind,
  running,
  reduce,
}: {
  result: ComparisonResult;
  blind: boolean;
  running: boolean;
  reduce: boolean;
}) {
  const hasStatus = result.variants.some((v) => v.status !== undefined);
  // A streaming-capable payload renders EVERY lane (placeholders keep their
  // slots); a saved artifact keeps the prior behaviour of hiding empty lanes.
  const shown = hasStatus
    ? result.variants
    : result.variants.filter((variant) => variant.content.trim().length > 0);
  if (shown.length === 0) return null;
  const ordered = orderVariantsByRank(shown, result.ranking);
  const responded = shown.filter(
    (v) => variantStatus(v) === "responded",
  ).length;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">Variants</h2>
        {hasStatus && (
          <div className="flex items-center gap-2">
            {/* The spinner crossfades out as the run settles; the survivor pill
                stays throughout so the count reads the same live and final. */}
            <AnimatePresence initial={false}>
              {running && (
                <motion.span
                  key="running-spinner"
                  aria-hidden
                  {...crossfadePresence(reduce)}
                  className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-orange motion-reduce:animate-none"
                />
              )}
            </AnimatePresence>
            <RespondedPill responded={responded} total={shown.length} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {ordered.map((variant, index) => {
          const card = (
            <VariantCard
              variant={variant}
              rank={rankForLabel(result.ranking, variant.label)}
              blind={blind}
              running={running}
            />
          );
          if (reduce) return <div key={variant.label}>{card}</div>;
          return (
            <motion.div
              key={variant.label}
              data-animated="true"
              {...motionPropsWhen(reduce, {
                initial: { opacity: 0, y: 8 },
                animate: { opacity: 1, y: 0 },
                transition: staggerItemTransition(index),
              })}
            >
              {card}
            </motion.div>
          );
        })}
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
  /**
   * The run-level phase. `"running"` renders the live grid with no
   * winner accent (nothing is decided yet); `"final"` (the default) is the
   * settled state where the ranking's winner earns the accent. Drives the
   * spinner→result pill crossfade and the entrance animation.
   */
  status?: "running" | "final";
}

/**
 * Render an A/B comparison result: a lead summary, the ranking (winner
 * accented), the recommendation as a labeled conclusion, and the variant
 * outputs side by side. The single renderer for both the live run (per-variant
 * streaming / no-response cells, no winner accent) and the saved artifact, so
 * the finished comparison looks exactly like the in-flight review.
 */
export function ComparisonView({
  result,
  blind = false,
  status = "final",
}: ComparisonViewProps) {
  const reduce = useReducedMotion() === true;
  const running = status === "running";
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

      <VariantsSection
        result={result}
        blind={blind}
        running={running}
        reduce={reduce}
      />
    </div>
  );
}
