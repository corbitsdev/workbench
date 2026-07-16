import { sumAnalyticsModelTokens } from "@workbench/analytics/model-tokens";
import type { ActivityOverview } from "../../lib/hub-api";
import {
  cacheHitRate,
  formatCompact,
  ratePct,
  sumInferenceTokenClasses,
} from "./metrics";
import { CardLabel, CaveatNote, formatNumber, HudCard, Stat } from "./stats";
import { MiniBars, TokenMosaic } from "./viz";
import { SectionLabel } from "./section-label";

/**
 * Usage & Cost tab detail (CL-3667). The Total-turns / Tool-calls stat tiles
 * that used to open this section were dropped — they duplicated the Trends
 * section's turns/day and tool-calls/day trend cards one section up, which
 * already carry the same totals plus a delta and sparkline. This section keeps
 * only the figures the trend cards don't show: success rate context, cache
 * hit rate, thinking-token share, the token mix, and the model distribution.
 */
export function InferenceSection({
  data,
  tokenCaveat,
}: {
  data: ActivityOverview;
  tokenCaveat: string | null;
}) {
  const summary = data.inference.summary;
  const tokens = sumInferenceTokenClasses(summary);

  const allZero =
    summary.turnCount === 0 && summary.toolCallCount === 0 && tokens === 0;

  if (allZero) {
    return (
      <div className="flex flex-col gap-4">
        <SectionLabel>Inference &amp; tool usage</SectionLabel>
        <div className="flex flex-col items-center justify-center gap-2 rounded-[12px] border border-border bg-surface py-16 text-center">
          <span className="text-[14px] text-text-2">No activity yet</span>
          <span className="text-[12px] text-text-3">
            Usage data appears once your workbench has activity
          </span>
        </div>
      </div>
    );
  }

  const successfulTurns = summary.turnCount - summary.failedTurnCount;
  const successfulTools = summary.toolCallCount - summary.toolErrorCount;
  const turnRate = ratePct(successfulTurns, summary.turnCount);
  const toolRate = ratePct(successfulTools, summary.toolCallCount);
  const hitRate = cacheHitRate(summary.inputTokens, summary.cacheReadTokens);
  const thinkPct = ratePct(summary.thinkingTokens, tokens);
  const modelRows = data.byModel
    .filter((row) => row.turnCount > 0 || sumAnalyticsModelTokens(row) > 0)
    .map((row) => {
      const tokenTotal = sumAnalyticsModelTokens(row);
      return {
        key: row.model,
        value: tokenTotal,
        displayValue:
          row.turnCount > 0
            ? `${formatNumber(row.turnCount)} turns`
            : formatCompact(tokenTotal),
      };
    });

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Inference &amp; tool usage</SectionLabel>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Turn success rate"
          value={`${turnRate.toFixed(1)}%`}
          sub={`${formatNumber(summary.failedTurnCount)} failed`}
          danger={summary.failedTurnCount > 0}
        />
        <Stat
          label="Tool success rate"
          value={
            tokenCaveat === null ? `${toolRate.toFixed(1)}%` : "unavailable"
          }
          sub={`${formatNumber(summary.toolErrorCount)} errors`}
          danger={tokenCaveat === null && summary.toolErrorCount > 0}
        />
        <Stat
          label="Cache hit rate"
          value={`${hitRate.toFixed(0)}%`}
          sub="of read tokens"
        />
        <Stat
          label="Thinking tokens"
          value={`${thinkPct.toFixed(0)}%`}
          sub="of all tokens"
        />
      </div>

      <HudCard
        label="Token mix"
        tag={
          tokens > 0 ? (
            <CardLabel>{formatNumber(tokens)} total</CardLabel>
          ) : undefined
        }
      >
        {tokens > 0 ? (
          <TokenMosaic
            label="Token usage breakdown"
            parts={[
              { label: "Input", value: summary.inputTokens },
              { label: "Output", value: summary.outputTokens },
              { label: "Cache read", value: summary.cacheReadTokens },
              { label: "Cache write", value: summary.cacheWriteTokens },
              { label: "Thinking", value: summary.thinkingTokens },
            ]}
          />
        ) : (
          <div className="flex flex-col items-start gap-2 py-2">
            <span className="text-[12px] text-text-2">
              No token data for this range
            </span>
            {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
          </div>
        )}
      </HudCard>

      {modelRows.length > 0 && (
        <HudCard
          label="Models · by turns or tokens"
          tag={
            modelRows.length > 8 ? (
              <CardLabel>{`+${modelRows.length - 8} more`}</CardLabel>
            ) : undefined
          }
        >
          <MiniBars
            label="Model distribution"
            rows={modelRows.slice(0, 8).map((m) => ({
              label: m.key,
              value: m.value,
              displayValue: m.displayValue,
            }))}
          />
        </HudCard>
      )}
    </div>
  );
}
