// Plain catalog-row literals so the resolution suites exercise the real
// algorithm with no database anywhere near them — the platform's model
// discovery response, already flattened, as `catalog.ts` produces it.
import type { Capability } from "@intx/types";

import type { CatalogOffering, CatalogPricingRow } from "../src/catalog";

export type OfferingFixture = {
  id: string;
  canonicalName: string;
  displayName?: string | null;
  providerName: string;
  plugin?: string;
  capabilities: Capability[];
  priority?: number;
};

export function offering(fixture: OfferingFixture): CatalogOffering {
  return {
    offeringId: fixture.id,
    canonicalName: fixture.canonicalName,
    displayName: fixture.displayName ?? null,
    providerName: fixture.providerName,
    plugin: fixture.plugin ?? "openai-compatible",
    priority: fixture.priority ?? 0,
    capabilities: fixture.capabilities,
  };
}

export type PricingFixture = {
  offeringId: string;
  /** USD per million tokens; stored per-token, as the column requires. */
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  currency?: string;
};

export function pricing(fixture: PricingFixture): CatalogPricingRow {
  const perToken = (perMTok: number | null): string | null =>
    perMTok === null ? null : String(perMTok / 1_000_000);
  return {
    offeringId: fixture.offeringId,
    currency: fixture.currency ?? "USD",
    inputTokenPrice: perToken(fixture.inputUsdPerMTok),
    outputTokenPrice: perToken(fixture.outputUsdPerMTok),
  };
}
