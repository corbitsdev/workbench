// Converts decimal-string per-token prices to USD/million. A missing row
// yields `known: false`, never a fabricated zero that wins cheapest-first.
import type { CatalogPricingRow } from "./catalog";

export const DEFAULT_CURRENCY = "USD";

export type OfferingPrice = {
  readonly currency: string;
  readonly known: boolean;
  readonly inputUsdPerMTok: number | null;
  readonly outputUsdPerMTok: number | null;
};

const TOKENS_PER_MTOK = 1_000_000;

/** Converts one per-token decimal string to USD per million tokens. */
export function perMTok(perToken: string | null | undefined): number | null {
  if (perToken === null || perToken === undefined) return null;
  const parsed = Number(perToken);
  return Number.isFinite(parsed) ? parsed * TOKENS_PER_MTOK : null;
}

export function groupPricingByOffering(
  rows: readonly CatalogPricingRow[],
): Map<string, CatalogPricingRow[]> {
  const byOffering = new Map<string, CatalogPricingRow[]>();
  for (const row of rows) {
    const existing = byOffering.get(row.offeringId);
    if (existing === undefined) byOffering.set(row.offeringId, [row]);
    else existing.push(row);
  }
  return byOffering;
}

/** The offering's price in `currency`, in USD per million tokens. */
export function priceForOffering(
  rows: readonly CatalogPricingRow[],
  currency: string,
): OfferingPrice {
  const active = rows.find((row) => row.currency === currency);
  if (active === undefined) {
    return {
      currency,
      known: false,
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
    };
  }
  const inputUsdPerMTok = perMTok(active.inputTokenPrice);
  const outputUsdPerMTok = perMTok(active.outputTokenPrice);
  return {
    currency,
    known: inputUsdPerMTok !== null && outputUsdPerMTok !== null,
    inputUsdPerMTok,
    outputUsdPerMTok,
  };
}

/** What one concept's reference workload would cost at this price, in USD.
 * Null whenever the price is not fully known — never a partial estimate. */
export function referenceCostUsd(
  price: OfferingPrice,
  mix: { readonly inputMTok: number; readonly outputMTok: number },
): number | null {
  if (!price.known) return null;
  if (price.inputUsdPerMTok === null || price.outputUsdPerMTok === null) {
    return null;
  }
  return price.inputUsdPerMTok * mix.inputMTok + price.outputUsdPerMTok * mix.outputMTok;
}

/** What a run of the given size would cost at this price, in USD. Null
 * whenever either axis is unpriced: half an estimate is not an estimate,
 * and a zero would read as free. */
export function estimateUsd(
  price: OfferingPrice,
  expectedInputTokens: number,
  expectedOutputTokens: number,
): number | null {
  if (price.inputUsdPerMTok === null || price.outputUsdPerMTok === null) {
    return null;
  }
  return (
    (price.inputUsdPerMTok * expectedInputTokens) / TOKENS_PER_MTOK +
    (price.outputUsdPerMTok * expectedOutputTokens) / TOKENS_PER_MTOK
  );
}
