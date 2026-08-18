import { computeCost, contextTokens, totalTokens } from "./cost";
import { PROVIDER_PRICES } from "./rates";
import type { LookupRatesInput, TokenClasses, TokenRates } from "./types";

const BY_PROVIDER_MODEL = new Map(
  PROVIDER_PRICES.map((price) => [`${price.provider}\0${price.model}`, price]),
);

/**
 * Rates for one `(provider, model)` at a given prompt-side context size.
 * Unknown pair → null. Same model id on two providers is two rows.
 */
export function lookupRates(input: LookupRatesInput): TokenRates | null {
  const price = BY_PROVIDER_MODEL.get(`${input.provider}\0${input.model}`);
  if (price === undefined) return null;
  let chosen = price.tiers[0];
  if (chosen === undefined) return null;
  for (const tier of price.tiers) {
    if (input.contextTokens >= tier.minContextTokens) chosen = tier;
  }
  return chosen.rates;
}

/**
 * Look up rates and multiply. Unknown pair with tokens → null, not $0.
 * Zero-token turns cost $0 even without a row.
 */
export function costUsd(input: {
  readonly provider: string;
  readonly model: string;
  readonly tokens: TokenClasses;
}): number | null {
  const rates = lookupRates({
    provider: input.provider,
    model: input.model,
    contextTokens: contextTokens(input.tokens),
  });
  if (rates === null) return totalTokens(input.tokens) === 0 ? 0 : null;
  return computeCost(input.tokens, rates).totalUsd;
}
