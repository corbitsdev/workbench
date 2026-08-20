import type { SupportedCredentialProvider } from "@workbench/hub-client/credential-test";

import type { CatalogModelName } from "./catalog-models";
import type { ModelPrice, RateTier, TokenRates } from "./types";

function usd(
  input: number,
  output: number,
  cacheRead: number | null,
  cacheWrite: number | null,
  thinking: number | null = output,
): TokenRates {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWritePerMTok: cacheWrite,
    thinkingPerMTok: thinking,
  };
}

/** A priced row whose wire model id is a real `@intx/inference-catalog` model. */
function priced(
  provider: SupportedCredentialProvider,
  model: CatalogModelName,
  base: TokenRates,
  higher?: readonly RateTier[],
): ModelPrice {
  return {
    provider,
    model,
    catalogModel: model,
    tiers: [{ minContextTokens: 0, rates: base }, ...(higher ?? [])],
  };
}

/**
 * A priced row whose wire model id the pinned catalog does not carry —
 * an OpenRouter/Hugging Face namespaced id, an Ollama tag, or a model the
 * catalog hasn't onboarded. `reason` is required so the gap is a
 * documented decision, not a silent omission.
 */
function unpriced(
  provider: SupportedCredentialProvider,
  model: string,
  reason: string,
  base: TokenRates,
  higher?: readonly RateTier[],
): ModelPrice {
  return {
    provider,
    model,
    catalogModel: null,
    uncatalogedReason: reason,
    tiers: [{ minContextTokens: 0, rates: base }, ...(higher ?? [])],
  };
}

const FREE = usd(0, 0, 0, 0, 0);

const OPENROUTER_NAMESPACED =
  "OpenRouter namespaces this wire id with its own vendor prefix; the pinned catalog's canonical id carries no such prefix, so this exact string is not a catalog member.";

const NOT_IN_PINNED_CATALOG =
  "Not present in the pinned @intx/inference-catalog snapshot — the catalog has not onboarded this model/deployment yet.";

const HUGGINGFACE_REPO_ID =
  "Hugging Face bills by its own `org/Repo-Name` inference-endpoint id, which the catalog does not carry — it only tracks each model's first-party canonical name.";

const OLLAMA_LOCAL_TAG =
  "Ollama tags a locally pulled model with its own size/quant suffix, which the catalog does not carry — it only tracks each model's first-party canonical name.";

/**
 * Catalog-seed prices from models.dev (2026-04-18), keyed by workbench
 * provider name + the wire model id that lands on a usage turn. Thinking
 * is billed at the provider's `reasoning` rate when listed, otherwise at
 * the output rate (the usual "thinking is output" rule).
 *
 * Every row's `provider` is a `SupportedCredentialProvider` — a
 * misspelled or unsupported provider is a compile error. Every row's
 * `model` is billed as the real wire id; `priced()` additionally proves
 * that id is a genuine `@intx/inference-catalog` model (also a compile
 * error to get wrong), while `unpriced()` marks a wire id the pinned
 * catalog does not carry, with a named reason instead of a silent gap.
 * The reverse case — a catalog model with no price row here, e.g. `gpt-5`
 * or `o3` — is not a gap either: `lookupRates`/`costUsd` return `null` for
 * any (provider, model) this list doesn't cover, catalog member or not
 * (see `lookup.test.ts`'s "catalog model with no price row" case).
 */
export const PROVIDER_PRICES: readonly ModelPrice[] = [
  priced("anthropic", "claude-sonnet-5", usd(2, 10, 0.2, 2.5)),

  priced("openai", "gpt-5.6-terra", usd(2, 12, 0.2, 2.5), [
    { minContextTokens: 272_000, rates: usd(4, 18, 0.4, 5) },
  ]),
  priced("openai", "gpt-4o-mini", usd(0.15, 0.6, 0.075, null)),

  unpriced(
    "google-genai",
    "gemini-3.7-flash",
    NOT_IN_PINNED_CATALOG,
    usd(0.1, 0.4, 0.01, 0.125, 0.4),
  ),
  priced("google-genai", "gemini-2.5-flash", usd(0.3, 2.5, 0.03, 0.38333, 2.5)),

  priced("xai", "grok-4.6", usd(2, 6, 0.2, 2.5), [
    { minContextTokens: 200_000, rates: usd(4, 12, 0.4, 5) },
  ]),
  priced("xai", "grok-4.5", usd(2, 6, 0.2, 2.5), [
    { minContextTokens: 200_000, rates: usd(4, 12, 0.4, 5) },
  ]),

  unpriced(
    "openrouter",
    "qwen/qwen3.8-27b",
    NOT_IN_PINNED_CATALOG,
    usd(0.09, 0.29, 0.018, 0.1125),
  ),
  unpriced(
    "openrouter",
    "anthropic/claude-sonnet-5",
    OPENROUTER_NAMESPACED,
    usd(2, 10, 0.2, 3.125),
  ),
  unpriced(
    "openrouter",
    "openai/gpt-5.6-sol",
    OPENROUTER_NAMESPACED,
    usd(2, 12, 0.2, 2.5),
    [{ minContextTokens: 272_000, rates: usd(4, 18, 0.4, 5) }],
  ),
  unpriced(
    "openrouter",
    "meta-llama/llama-3.3-70b-instruct",
    NOT_IN_PINNED_CATALOG,
    usd(0.1, 0.32, 0.02, 0.125),
  ),
  unpriced(
    "openrouter",
    "google/gemma-4-26b-a4b-it:free",
    NOT_IN_PINNED_CATALOG,
    FREE,
  ),

  priced("opencode-zen", "qwen3.7-plus", usd(0.32, 1.28, 0.064, 0.4), [
    { minContextTokens: 256_000, rates: usd(0.96, 3.84, 0.192, 1.2) },
  ]),
  priced("opencode-zen", "claude-sonnet-5", usd(1.7, 8.5, 0.17, 2.125)),
  priced("opencode-zen", "gpt-5.4-mini", usd(0.4, 1.6, 0.04, 0.5)),
  priced("opencode-zen", "deepseek-v4-flash", usd(0.14, 0.28, 0.028, 0.175)),
  priced("opencode-zen", "kimi-k2.6", usd(0.5, 2.8, 0.1, 0.625)),

  unpriced(
    "groq",
    "llama-3.3-70b-versatile",
    NOT_IN_PINNED_CATALOG,
    usd(0.59, 0.79, null, null),
  ),
  unpriced(
    "groq",
    "llama-3.1-8b-instant",
    NOT_IN_PINNED_CATALOG,
    usd(0.05, 0.08, null, null),
  ),
  unpriced(
    "groq",
    "openai/gpt-oss-120b",
    NOT_IN_PINNED_CATALOG,
    usd(0.15, 0.6, 0.075, null),
  ),

  priced("deepseek", "deepseek-v4-flash", usd(0.14, 0.28, 0.028, 0.175)),
  priced("deepseek", "deepseek-v4-pro", usd(1.74, 3.48, 0.145, 2.175)),

  unpriced(
    "mistral",
    "mistral-small-2603",
    NOT_IN_PINNED_CATALOG,
    usd(0.15, 0.6, 0.03, 0.1875),
  ),
  unpriced(
    "mistral",
    "mistral-large-2512",
    NOT_IN_PINNED_CATALOG,
    usd(0.5, 1.5, 0.05, 0.625, 1.5),
  ),
  unpriced(
    "mistral",
    "codestral-2508",
    NOT_IN_PINNED_CATALOG,
    usd(0.3, 0.9, null, null),
  ),

  unpriced(
    "huggingface",
    "deepseek-ai/DeepSeek-V4-Flash",
    HUGGINGFACE_REPO_ID,
    usd(0.14, 0.28, 0.028, 0.175),
  ),
  unpriced(
    "huggingface",
    "meta-llama/Llama-3.3-70B-Instruct",
    HUGGINGFACE_REPO_ID,
    usd(0.1, 0.32, 0.03, 0.1),
  ),
  unpriced(
    "huggingface",
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    HUGGINGFACE_REPO_ID,
    usd(0.07, 0.27, 0.014, 0.0875),
  ),

  unpriced("ollama", "qwen3.8:27b", OLLAMA_LOCAL_TAG, FREE),
  unpriced("ollama", "qwen3.5:9b-mlx", OLLAMA_LOCAL_TAG, FREE),
];
