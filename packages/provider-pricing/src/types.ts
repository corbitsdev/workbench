import type { SupportedCredentialProvider } from "@workbench/connections/credential-test";

import type { CatalogModelName } from "./catalog-models";

/**
 * Token classes a turn may report. Cost is the sum of each class's
 * (tokens / 1e6) * rate-per-MTok when that rate is known.
 */
export type TokenClasses = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly thinking: number;
};

export type TokenRates = {
  readonly inputPerMTok: number | null;
  readonly cacheReadPerMTok: number | null;
  readonly cacheWritePerMTok: number | null;
  readonly outputPerMTok: number | null;
  readonly thinkingPerMTok: number | null;
};

export type RateTier = {
  /** Inclusive lower bound on prompt-side tokens (input + cache). */
  readonly minContextTokens: number;
  readonly rates: TokenRates;
};

/**
 * A priced (provider, model) pair. `provider` is typed against
 * `SupportedCredentialProvider` — the same provider identity workbench
 * already uses for credentials and the catalog's adapter plugin mapping
 * (see `@workbench/connections/credential-test`) — so a misspelled or
 * unsupported provider is a compile error.
 *
 * `model` is the actual wire id billed on a usage turn, which is not
 * always a catalog canonical name (OpenRouter and Hugging Face namespace
 * their ids, Ollama tags carry a size/quant suffix, and several relays
 * serve models the catalog hasn't onboarded). Where the wire id *is* a
 * catalog canonical name, `catalogModel` repeats it as a
 * `CatalogModelName` — a compile-time check that the id is real — and
 * where it isn't, `catalogModel` is explicitly `null` with a documented
 * reason, never a silent gap.
 */
export type ModelPrice = {
  readonly provider: SupportedCredentialProvider;
  readonly model: string;
  readonly tiers: readonly RateTier[];
} & (
  | { readonly catalogModel: CatalogModelName }
  | { readonly catalogModel: null; readonly uncatalogedReason: string }
);

export type LookupRatesInput = {
  readonly provider: string;
  readonly model: string;
  readonly contextTokens: number;
};

export type CostBreakdown = {
  /** USD total, or null when any class with tokens > 0 lacks a rate. */
  readonly totalUsd: number | null;
  readonly byClass: {
    readonly input: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
    readonly output: number | null;
    readonly thinking: number | null;
  };
};
