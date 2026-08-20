import type { CostBreakdown, TokenClasses, TokenRates } from "./types";

/**
 * Compute cost for one turn. A class with zero tokens contributes 0
 * even without a rate. A class with tokens > 0 and a null rate makes
 * that class — and therefore the total — absent (null). Never invents
 * a zero cost for an unknown rate.
 */
export function computeCost(
  tokens: TokenClasses,
  rates: TokenRates,
): CostBreakdown {
  const input = classCost(tokens.input, rates.inputPerMTok);
  const cacheRead = classCost(tokens.cacheRead, rates.cacheReadPerMTok);
  const cacheWrite = classCost(tokens.cacheWrite, rates.cacheWritePerMTok);
  const output = classCost(tokens.output, rates.outputPerMTok);
  const thinking = classCost(tokens.thinking, rates.thinkingPerMTok);

  const parts = [input, cacheRead, cacheWrite, output, thinking];
  const totalUsd = parts.some((p) => p === null)
    ? null
    : parts.reduce<number>((sum, p) => sum + (p as number), 0);

  return {
    totalUsd,
    byClass: { input, cacheRead, cacheWrite, output, thinking },
  };
}

function classCost(tokens: number, ratePerMTok: number | null): number | null {
  if (tokens === 0) return 0;
  if (ratePerMTok === null) return null;
  return (tokens / 1_000_000) * ratePerMTok;
}

/** Sum token classes from a row-shaped object. */
export function totalTokens(tokens: TokenClasses): number {
  return (
    tokens.input +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.output +
    tokens.thinking
  );
}

/** Prompt-side tokens used to pick a context-size rate tier. */
export function contextTokens(tokens: TokenClasses): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}
