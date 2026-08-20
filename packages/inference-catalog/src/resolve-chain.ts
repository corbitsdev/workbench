// Chain resolution: what this bench can reach for a given kind of work,
// cheapest first, with fallbacks.
//
// Pure — every read is done by the caller and handed in, so the whole
// algorithm is exercised with plain literals and no database. It answers
// with an ordered chain, never a single model: one model is not a fallback
// plan, and the platform's own source resolution already consumes chains.
//
// It also never resolves credentials or builds an InferenceSource. Its
// output projects to `ModelRequirement[]`, which `resolveModelSources`
// turns into runnable sources — the capability predicate and the priority
// tiebreakers here are deliberately the same ones it uses, so a chain this
// package returns can never be rejected downstream by upstream's own rules.
import type { ResolvedOffering, ModelPricingRow } from "@intx/db";
import type { Capability, ProviderPreference } from "@intx/types";

import {
  conceptById,
  CONCEPT_IDS,
  DEFAULT_MIX,
  type ConceptCeiling,
  type ReferenceMix,
} from "./concepts";
import {
  DEFAULT_CURRENCY,
  groupPricingByOffering,
  priceForOffering,
  referenceCostUsd,
  type OfferingPrice,
} from "./price";
import { EMPTY_POLICY, matchesAny, type BenchModelPolicy } from "./policy";

export class UnknownConceptError extends Error {
  constructor(readonly concept: string) {
    super(
      `"${concept}" is not a kind of work this bench knows. Available: ${CONCEPT_IDS.join(", ")}.`,
    );
    this.name = "UnknownConceptError";
  }
}

export type ChainNeed =
  | { readonly concept: string }
  | { readonly capabilities: readonly Capability[] };

export type ChainOrder = "cheapest" | "catalog";

export type ResolveChainInput = {
  readonly need: ChainNeed;
  readonly offerings: readonly ResolvedOffering[];
  readonly pricing: readonly ModelPricingRow[];
  readonly policy: BenchModelPolicy;
  /** Never read from the clock inside: discovery passes now, historical
   * attribution passes the moment it is attributing. */
  readonly asOf: Date;
  readonly currency?: string | undefined;
  readonly limit?: number | undefined;
  readonly order?: ChainOrder | undefined;
};

export type ExclusionReason =
  | "provider-not-connected"
  | "missing-capabilities"
  | "policy-deny"
  | "outside-policy-allow"
  | "over-bench-ceiling";

export type ChainEntry = {
  readonly canonicalName: string;
  readonly displayName: string | null;
  readonly providerName: string;
  readonly plugin: string;
  readonly offeringId: string;
  readonly priority: number;
  readonly capabilities: readonly Capability[];
  readonly price: OfferingPrice;
  readonly referenceCostUsd: number | null;
  readonly overCeiling: boolean;
  readonly provenance: "set-here" | "inherited";
};

export type ModelChain = {
  readonly concept: string | null;
  readonly requiredCapabilities: readonly Capability[];
  /** May be empty. An empty chain is returned as-is with its reasons — this
   * package never synthesizes an entry to avoid answering "nothing". */
  readonly entries: readonly ChainEntry[];
  readonly excluded: readonly {
    readonly offeringId: string;
    readonly reason: ExclusionReason;
  }[];
  readonly policyApplied: {
    readonly allow: boolean;
    readonly deny: boolean;
    readonly ceiling: "none" | "soft" | "hard";
    readonly providerPreference: "none" | "pin" | "prefer";
  };
  readonly diversified: boolean;
};

const DEFAULT_LIMIT = 5;

type Candidate = {
  readonly entry: ChainEntry;
  readonly preferScore: number;
};

type Need = {
  readonly conceptId: string | null;
  readonly required: readonly Capability[];
  readonly preferred: readonly Capability[];
  readonly mix: ReferenceMix;
  readonly conceptCeiling: ConceptCeiling | null;
};

function resolveNeed(need: ChainNeed, policy: BenchModelPolicy): Need {
  if (!("concept" in need)) {
    return {
      conceptId: null,
      required: need.capabilities,
      preferred: [],
      mix: DEFAULT_MIX,
      conceptCeiling: null,
    };
  }
  const concept = conceptById(need.concept);
  if (concept === undefined) throw new UnknownConceptError(need.concept);
  const override = policy.conceptCeilings[concept.id];
  const conceptCeiling: ConceptCeiling =
    override === undefined
      ? concept.ceiling
      : {
          maxInputUsdPerMTok:
            override.maxInputUsdPerMTok ?? concept.ceiling.maxInputUsdPerMTok,
          maxOutputUsdPerMTok:
            override.maxOutputUsdPerMTok ?? concept.ceiling.maxOutputUsdPerMTok,
        };
  return {
    conceptId: concept.id,
    required: concept.requires,
    preferred: concept.prefers,
    mix: concept.referenceMix,
    conceptCeiling,
  };
}

function overCeiling(
  price: OfferingPrice,
  maxInput: number | null,
  maxOutput: number | null,
): boolean {
  if (!price.known) return false;
  if (
    maxInput !== null &&
    price.inputUsdPerMTok !== null &&
    price.inputUsdPerMTok > maxInput
  ) {
    return true;
  }
  return (
    maxOutput !== null &&
    price.outputUsdPerMTok !== null &&
    price.outputUsdPerMTok > maxOutput
  );
}

function compareStrings(left: ChainEntry, right: ChainEntry): number {
  return (
    left.canonicalName.localeCompare(right.canonicalName) ||
    left.providerName.localeCompare(right.providerName) ||
    left.offeringId.localeCompare(right.offeringId)
  );
}

function compareCandidates(order: ChainOrder) {
  return (left: Candidate, right: Candidate): number => {
    const leftCost = left.entry.referenceCostUsd;
    const rightCost = right.entry.referenceCostUsd;
    const byCost =
      leftCost === null || rightCost === null ? 0 : leftCost - rightCost;
    const byPriority = left.entry.priority - right.entry.priority;
    const byPreferred = right.preferScore - left.preferScore;
    const primary =
      order === "cheapest" ? byCost || byPriority : byPriority || byCost;
    return primary || byPreferred || compareStrings(left.entry, right.entry);
  };
}

/** `pin` keeps only the named providers; `prefer` fronts them and keeps the
 * rest as fallback. The platform applies the same two modes to inference
 * sources; its copy is not exported, so this is the same rule stated once
 * more against chain entries. */
function applyProviderPreference(
  entries: readonly ChainEntry[],
  preference: ProviderPreference | null,
): readonly ChainEntry[] {
  if (preference === null) return entries;
  const rank = new Map(preference.order.map((name, index) => [name, index]));
  if (preference.mode === "pin") {
    return entries.filter((entry) => rank.has(entry.providerName));
  }
  const named = entries.filter((entry) => rank.has(entry.providerName));
  const rest = entries.filter((entry) => !rank.has(entry.providerName));
  const ordered = [...named].sort(
    (left, right) =>
      (rank.get(left.providerName) ?? 0) - (rank.get(right.providerName) ?? 0),
  );
  return [...ordered, ...rest];
}

export function resolveModelChain(input: ResolveChainInput): ModelChain {
  const policy = input.policy;
  const currency = input.currency ?? DEFAULT_CURRENCY;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const order = input.order ?? "cheapest";
  const need = resolveNeed(input.need, policy);

  const pricingByOffering = groupPricingByOffering(input.pricing);
  const excluded: { offeringId: string; reason: ExclusionReason }[] = [];

  const within: Candidate[] = [];
  const over: Candidate[] = [];
  const unpriced: Candidate[] = [];

  for (const resolved of input.offerings) {
    const offeringId = resolved.offering.id;
    const canonicalName = resolved.model.canonicalName;
    const providerName = resolved.provider.name;

    if (resolved.provider.credentialId === null) {
      excluded.push({ offeringId, reason: "provider-not-connected" });
      continue;
    }

    const capabilities = resolved.offering.capabilities as Capability[];
    if (!need.required.every((required) => capabilities.includes(required))) {
      excluded.push({ offeringId, reason: "missing-capabilities" });
      continue;
    }

    const identity = { canonicalName, providerName };
    if (matchesAny(policy.deny, identity)) {
      excluded.push({ offeringId, reason: "policy-deny" });
      continue;
    }
    if (policy.allow.length > 0 && !matchesAny(policy.allow, identity)) {
      excluded.push({ offeringId, reason: "outside-policy-allow" });
      continue;
    }

    const price = priceForOffering(
      pricingByOffering.get(offeringId) ?? [],
      input.asOf,
      currency,
    );
    const overBenchCeiling = overCeiling(
      price,
      policy.maxInputUsdPerMTok,
      policy.maxOutputUsdPerMTok,
    );
    if (overBenchCeiling && policy.ceilingIsHard) {
      excluded.push({ offeringId, reason: "over-bench-ceiling" });
      continue;
    }
    const overConceptCeiling =
      need.conceptCeiling !== null &&
      overCeiling(
        price,
        need.conceptCeiling.maxInputUsdPerMTok,
        need.conceptCeiling.maxOutputUsdPerMTok,
      );
    const isOverCeiling = overBenchCeiling || overConceptCeiling;

    const entry: ChainEntry = {
      canonicalName,
      displayName: resolved.model.displayName,
      providerName,
      plugin: resolved.provider.plugin,
      offeringId,
      priority: resolved.offering.priority,
      capabilities,
      price,
      referenceCostUsd: referenceCostUsd(price, need.mix),
      overCeiling: isOverCeiling,
      provenance: resolved.origin.direct ? "set-here" : "inherited",
    };
    const candidate: Candidate = {
      entry,
      preferScore: need.preferred.filter((wanted) =>
        capabilities.includes(wanted),
      ).length,
    };

    if (!price.known) unpriced.push(candidate);
    else if (isOverCeiling) over.push(candidate);
    else within.push(candidate);
  }

  const compare = compareCandidates(order);
  const unpricedCompare = compareCandidates("catalog");
  const ranked = [
    ...[...within].sort(compare),
    ...[...over].sort(compare),
    ...[...unpriced].sort(unpricedCompare),
  ].map((candidate) => candidate.entry);

  const preferred = applyProviderPreference(ranked, policy.providerPreference);
  const capped = preferred.slice(0, limit);
  const diversified = shouldDiversify(capped, preferred);
  const entries = diversified ? diversify(capped, preferred) : capped;

  return {
    concept: need.conceptId,
    requiredCapabilities: need.required,
    entries,
    excluded,
    policyApplied: {
      allow: policy.allow.length > 0,
      deny: policy.deny.length > 0,
      ceiling: ceilingMode(policy),
      providerPreference: policy.providerPreference?.mode ?? "none",
    },
    diversified,
  };
}

function ceilingMode(policy: BenchModelPolicy): "none" | "soft" | "hard" {
  const hasCeiling =
    policy.maxInputUsdPerMTok !== null || policy.maxOutputUsdPerMTok !== null;
  if (!hasCeiling) return "none";
  return policy.ceilingIsHard ? "hard" : "soft";
}

/** A chain whose every entry sits behind one provider fails whenever that
 * provider does. When the bench has another provider that qualifies, the
 * last slot goes to it. */
function shouldDiversify(
  capped: readonly ChainEntry[],
  ranked: readonly ChainEntry[],
): boolean {
  if (capped.length < 2) return false;
  const soleProvider = capped[0]?.providerName;
  if (capped.some((entry) => entry.providerName !== soleProvider)) return false;
  return ranked.some((entry) => entry.providerName !== soleProvider);
}

function diversify(
  capped: readonly ChainEntry[],
  ranked: readonly ChainEntry[],
): readonly ChainEntry[] {
  const soleProvider = capped[0]?.providerName;
  const alternative = ranked.find(
    (entry) => entry.providerName !== soleProvider,
  );
  if (alternative === undefined) return capped;
  return [...capped.slice(0, capped.length - 1), alternative];
}

/**
 * The hand-off to the platform: one requirement per canonical model, in
 * chain order. `ModelRequirements` rejects a repeated model, so the chain's
 * cross-provider deployments of one model collapse to a single requirement —
 * source resolution expands them back out to failover sources itself.
 */
export function chainToModelRequirements(
  chain: ModelChain,
  providers: ProviderPreference | null,
): readonly {
  model: string;
  capabilities: Capability[];
  providers?: ProviderPreference;
}[] {
  const seen = new Set<string>();
  const requirements: {
    model: string;
    capabilities: Capability[];
    providers?: ProviderPreference;
  }[] = [];
  for (const entry of chain.entries) {
    if (seen.has(entry.canonicalName)) continue;
    seen.add(entry.canonicalName);
    requirements.push(
      providers === null
        ? {
            model: entry.canonicalName,
            capabilities: [...chain.requiredCapabilities],
          }
        : {
            model: entry.canonicalName,
            capabilities: [...chain.requiredCapabilities],
            providers,
          },
    );
  }
  return requirements;
}

export { EMPTY_POLICY };
