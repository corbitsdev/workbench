// Price normalization. `model_pricing` stores per-token prices as decimal
// strings; every human number in this package — ceilings, estimates, the
// copy an agent reads — is USD per million tokens. That conversion happens
// here and nowhere else.
//
// A missing row, a missing currency, or a null price component yields
// `known: false` with null numbers. It never yields zero: a fabricated zero
// would read as "free" and quietly win every cheapest-first sort.
import { resolveActivePrice, type ModelPricingRow } from "@intx/db";

export const DEFAULT_CURRENCY = "USD";

export type OfferingPrice = {
  readonly currency: string;
  readonly known: boolean;
  readonly inputUsdPerMTok: number | null;
  readonly outputUsdPerMTok: number | null;
};

const TOKENS_PER_MTOK = 1_000_000;

/** Converts one per-token decimal string to USD per million tokens. */
export function perMTok(perToken: string | null): number | null {
  if (perToken === null) return null;
  const parsed = Number(perToken);
  return Number.isFinite(parsed) ? parsed * TOKENS_PER_MTOK : null;
}

export function groupPricingByOffering(
  rows: readonly ModelPricingRow[],
): Map<string, ModelPricingRow[]> {
  const byOffering = new Map<string, ModelPricingRow[]>();
  for (const row of rows) {
    const existing = byOffering.get(row.offeringId);
    if (existing === undefined) byOffering.set(row.offeringId, [row]);
    else existing.push(row);
  }
  return byOffering;
}

/**
 * The price in effect for one offering at `asOf`, in USD per million tokens.
 * As-of selection is the platform's own `resolveActivePrice`; this adds only
 * the currency pick and the per-million normalization.
 */
export function priceForOffering(
  rows: readonly ModelPricingRow[],
  asOf: Date,
  currency: string,
): OfferingPrice {
  const active = resolveActivePrice([...rows], asOf).find(
    (row) => row.currency === currency,
  );
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
  return (
    price.inputUsdPerMTok * mix.inputMTok +
    price.outputUsdPerMTok * mix.outputMTok
  );
}
