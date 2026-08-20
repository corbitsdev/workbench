// A bench's model policy: the one row this package stores. Everything else
// it answers is derived at read time from the platform's own catalog and
// price history.
//
// A bench with no row uses EMPTY_POLICY, which constrains nothing — that is
// what makes a freshly connected bench work with no configuration at all.
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

/** The write boundary: every field optional, absent fields left untouched.
 * `null` on a ceiling clears it. */
export const BenchModelPolicyPatch = type({
  "allow?": "string[]",
  "deny?": "string[]",
  "maxInputUsdPerMTok?": "number >= 0 | null",
  "maxOutputUsdPerMTok?": "number >= 0 | null",
  "ceilingIsHard?": "boolean",
  "conceptCeilings?": type.Record("string", PolicyCeilingBody),
  "providerPreference?": ProviderPreference.or("null"),
});
export type BenchModelPolicyPatch = typeof BenchModelPolicyPatch.infer;

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
