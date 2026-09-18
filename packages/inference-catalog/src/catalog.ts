// The catalog shape chain resolution works on: the platform's model
// discovery response, parsed. Nothing here reaches a database.
import { type } from "arktype";

import { Capability } from "./capabilities";

/** One active price row for an offering, prices per token as decimal
 * strings — the column's own units, normalized to USD per million tokens
 * in `price.ts` and nowhere else. */
export const CatalogPricingRow = type({
  offeringId: "string",
  currency: "string",
  "inputTokenPrice?": "string | null",
  "outputTokenPrice?": "string | null",
});
export type CatalogPricingRow = typeof CatalogPricingRow.infer;

export const DiscoveredModelOffering = type({
  offeringId: "string",
  providerName: "string",
  plugin: "string",
  priority: "number",
  capabilities: Capability.array(),
  pricing: CatalogPricingRow.array(),
});

export const DiscoveredModel = type({
  id: "string",
  canonicalName: "string",
  "displayName?": "string | null",
  offerings: DiscoveredModelOffering.array(),
});
export type DiscoveredModel = typeof DiscoveredModel.infer;

/** One model on one provider, the unit chain resolution ranks. */
export type CatalogOffering = {
  readonly offeringId: string;
  readonly canonicalName: string;
  readonly displayName: string | null;
  readonly providerName: string;
  readonly plugin: string;
  readonly priority: number;
  readonly capabilities: readonly Capability[];
};

/** Flattens the discovery response into the resolver's two inputs: one row
 * per (model, provider) pairing, and the price rows those offerings carry. */
export function catalogOfferingsFrom(models: readonly DiscoveredModel[]): {
  readonly offerings: readonly CatalogOffering[];
  readonly pricing: readonly CatalogPricingRow[];
} {
  const offerings: CatalogOffering[] = [];
  const pricing: CatalogPricingRow[] = [];
  for (const model of models) {
    for (const entry of model.offerings) {
      offerings.push({
        offeringId: entry.offeringId,
        canonicalName: model.canonicalName,
        displayName: model.displayName ?? null,
        providerName: entry.providerName,
        plugin: entry.plugin,
        priority: entry.priority,
        capabilities: entry.capabilities,
      });
      pricing.push(...entry.pricing);
    }
  }
  return { offerings, pricing };
}
