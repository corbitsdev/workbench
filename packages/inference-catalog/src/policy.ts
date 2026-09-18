// A bench's model policy: what it is willing to spend, and on which models.
// Lives in tenant `config` under `corbits.modelPolicy` — no product table.
import { type } from "arktype";
import { ProviderPreference } from "@intx/types";

/** An allow/deny entry. Matched, in this order, as an exact canonical model
 * name, `provider:<providerName>`, or `<providerName>/<canonicalName>`. */
export type PolicySelector = string;

export type PolicyCeiling = {
  readonly maxInputUsdPerMTok: number | null;
  readonly maxOutputUsdPerMTok: number | null;
};

export type BenchModelPolicy = {
  readonly allow: readonly PolicySelector[];
  readonly deny: readonly PolicySelector[];
  readonly maxInputUsdPerMTok: number | null;
  readonly maxOutputUsdPerMTok: number | null;
  /** `false` sorts over-ceiling models last and flags them; `true` excludes
   * them outright. Concept ceilings stay soft either way. */
  readonly ceilingIsHard: boolean;
  /** Per-concept overrides of the shipped ceilings, keyed by concept id. */
  readonly conceptCeilings: Readonly<Record<string, PolicyCeiling>>;
  readonly providerPreference: ProviderPreference | null;
};

export const EMPTY_POLICY: BenchModelPolicy = {
  allow: [],
  deny: [],
  maxInputUsdPerMTok: null,
  maxOutputUsdPerMTok: null,
  ceilingIsHard: false,
  conceptCeilings: {},
  providerPreference: null,
};

const PolicyCeilingBody = type({
  "maxInputUsdPerMTok?": "number >= 0 | null",
  "maxOutputUsdPerMTok?": "number >= 0 | null",
});

/** The stored shape, under `config.corbits.modelPolicy`. Every field is
 * optional: a partially written key is read as the parts it does carry,
 * with EMPTY_POLICY supplying the rest. */
export const StoredModelPolicy = type({
  "allow?": "string[]",
  "deny?": "string[]",
  "maxInputUsdPerMTok?": "number >= 0 | null",
  "maxOutputUsdPerMTok?": "number >= 0 | null",
  "ceilingIsHard?": "boolean",
  "conceptCeilings?": type.Record("string", PolicyCeilingBody),
  "providerPreference?": ProviderPreference.or("null"),
});

const CorbitsTenantConfig = type({
  "corbits?": {
    "modelPolicy?": StoredModelPolicy,
    "[string]": "unknown",
  },
  "[string]": "unknown",
});

/** The key path a policy is stored and read under, as the stock PATCH body
 * spells it. */
export const MODEL_POLICY_CONFIG_PATH = ["corbits", "modelPolicy"] as const;

/** This bench's model policy. Anything the schema rejects reads as the parts
 * that do parse over EMPTY_POLICY — a malformed blob leaves the bench
 * unconstrained, never unable to pick a model. */
export function readModelPolicy(tenantConfig: unknown): BenchModelPolicy {
  const parsed = CorbitsTenantConfig(tenantConfig);
  if (parsed instanceof type.errors) return EMPTY_POLICY;
  const stored = parsed.corbits?.modelPolicy;
  if (stored === undefined) return EMPTY_POLICY;
  return {
    allow: stored.allow ?? EMPTY_POLICY.allow,
    deny: stored.deny ?? EMPTY_POLICY.deny,
    maxInputUsdPerMTok: stored.maxInputUsdPerMTok ?? null,
    maxOutputUsdPerMTok: stored.maxOutputUsdPerMTok ?? null,
    ceilingIsHard: stored.ceilingIsHard ?? EMPTY_POLICY.ceilingIsHard,
    conceptCeilings: readConceptCeilings(stored.conceptCeilings),
    providerPreference: stored.providerPreference ?? null,
  };
}

function readConceptCeilings(
  stored: Record<string, typeof PolicyCeilingBody.infer> | undefined,
): Readonly<Record<string, PolicyCeiling>> {
  if (stored === undefined) return EMPTY_POLICY.conceptCeilings;
  const ceilings: Record<string, PolicyCeiling> = {};
  for (const [concept, ceiling] of Object.entries(stored)) {
    ceilings[concept] = {
      maxInputUsdPerMTok: ceiling.maxInputUsdPerMTok ?? null,
      maxOutputUsdPerMTok: ceiling.maxOutputUsdPerMTok ?? null,
    };
  }
  return ceilings;
}

/** True when `selector` names this offering, under any of the three forms. */
export function selectorMatches(
  selector: PolicySelector,
  offering: { readonly canonicalName: string; readonly providerName: string },
): boolean {
  if (selector === offering.canonicalName) return true;
  if (selector === `provider:${offering.providerName}`) return true;
  return selector === `${offering.providerName}/${offering.canonicalName}`;
}

export function matchesAny(
  selectors: readonly PolicySelector[],
  offering: { readonly canonicalName: string; readonly providerName: string },
): boolean {
  return selectors.some((selector) => selectorMatches(selector, offering));
}
