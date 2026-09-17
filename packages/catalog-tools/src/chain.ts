// Chain resolution, in the workflow child.
//
// The two stock reads happen once per tool call and are then used for every
// question that call asks — `list_model_concepts` ranks every concept off
// one catalog read rather than one read per concept, which is what the
// deleted hub route did per request.
import {
  catalogOfferingsFrom,
  resolveModelChain,
  type BenchModelPolicy,
  type ChainNeed,
  type ChainOrder,
  type DiscoveredModel,
  type ModelChain,
} from "@corbits/inference-catalog";

import {
  fetchCatalog,
  fetchModelPolicy,
  type CatalogToolClientConfig,
} from "./client";

/** What this bench can reach and what it is willing to spend, read once. */
export type BenchCatalog = {
  readonly models: readonly DiscoveredModel[];
  readonly policy: BenchModelPolicy;
};

export async function readBenchCatalog(
  config: CatalogToolClientConfig,
): Promise<BenchCatalog> {
  const [models, policy] = await Promise.all([
    fetchCatalog(config),
    fetchModelPolicy(config),
  ]);
  return { models, policy };
}

export function chainFor(
  bench: BenchCatalog,
  need: ChainNeed,
  order?: ChainOrder,
  limit?: number,
): ModelChain {
  const { offerings, pricing } = catalogOfferingsFrom(bench.models);
  return resolveModelChain({
    need,
    offerings,
    pricing,
    policy: bench.policy,
    ...(order !== undefined ? { order } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

/** The one line that explains an otherwise puzzling chain: empty, entirely
 * unpriced, or partly over this bench's ceiling. */
export function chainNote(chain: ModelChain): string | null {
  if (chain.entries.length === 0) return "nothing on this bench can do that";
  if (chain.entries.every((entry) => !entry.price.known)) {
    return "nothing on this bench is priced yet, so cheapest-first is ordered by catalog priority";
  }
  if (chain.entries.some((entry) => entry.overCeiling)) {
    return "some of these cost more than this bench's ceiling for that kind of work";
  }
  return null;
}
