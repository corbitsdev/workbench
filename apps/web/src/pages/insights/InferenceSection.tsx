import type { ActivityOverview } from "../../lib/hub-api";
import { cacheHitRate, computeDelta, ratePct } from "./metrics";
import { CardLabel, CaveatNote, formatNumber, HudCard, Stat } from "./stats";
import { MiniBars, TokenMosaic } from "./viz";
import { SectionLabel } from "./section-label";

function totalTokens(s: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
}): number {
  return (
    s.inputTokens +
    s.outputTokens +
    s.cacheReadTokens +
    s.cacheWriteTokens +
    s.thinkingTokens
  );
}

export function InferenceSection({
  data,
  tokenCaveat,
}: {
  data: ActivityOverview;
  tokenCaveat: string | null;
}) {
  const summary = data.inference.summary;
  const prev = data.inference.previousSummary;
  const tokens = totalTokens(summary);

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
  const modelRows = data.models.filter((model) => model.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Inference &amp; tool usage</SectionLabel>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Total turns"
          value={formatNumber(summary.turnCount)}
          delta={computeDelta(summary.turnCount, prev?.turnCount ?? null)}
          sub={`${turnRate.toFixed(1)}% success`}
          danger={summary.failedTurnCount > 0}
        />
        <Stat
          label="Tool calls"
          value={formatNumber(summary.toolCallCount)}
          delta={computeDelta(
            summary.toolCallCount,
            prev?.toolCallCount ?? null,
          )}
          sub={
            tokenCaveat === null
              ? `${toolRate.toFixed(1)}% success`
              : "success rate unavailable"
          }
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
          label="Models · by turns"
          tag={
            modelRows.length > 8 ? (
              <CardLabel>{`+${modelRows.length - 8} more`}</CardLabel>
            ) : undefined
          }
        >
          <MiniBars
            label="Model distribution"
            rows={modelRows
              .slice(0, 8)
              .map((m) => ({ label: m.key, value: m.count }))}
          />
        </HudCard>
      )}
    </div>
  );
}
