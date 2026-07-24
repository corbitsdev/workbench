// The curated A/B preset line-ups. Each preset runs a shared prompt across four
// FIXED models, then a human picks the winner. `label` is the BLIND label the
// reviewer sees during the decision (the model identity is revealed only in the
// saved artifact); `model` is the catalog canonical name resolved at deploy.
//
// v1 runs every model through opencode-zen (the openai-compatible gateway), so
// the step declares no provider and the default `openai-compatible` plugin
// resolves the opencode-zen offering. Native-provider primaries with a
// opencode-zen fallback are a follow-up (CL-3080).
//
// A variant whose model also has a native-provider catalog offering (e.g.
// gemini-3.5-flash: opencode-zen AND google-ai) must pin `provider:
// LLM_PROVIDER` explicitly — otherwise resolution can land the step on the
// native offering, which expects that provider's own request body and 400s
// against the shared prompt payload.

import { LLM_PROVIDER } from "@workbench/agents";

export interface AbPresetVariant {
  /** Blind label shown to the reviewer, e.g. "Variant 1". */
  label: string;
  /** Catalog canonical model name, resolved at deploy. */
  model: string;
  /**
   * Optional inference plugin pin, passed through to `agentStep`.
   * Only needed when a model carries more than one catalog offering (e.g. a
   * gateway offering AND a native-provider offering) — pinning forces the
   * step onto the opencode-zen gateway offering instead of leaving the
   * catalog's second offering to resolve unpredictably.
   */
  provider?: string;
}

type VariantSpec = string | { model: string; provider: string };

export interface AbPresetConfig {
  /** Deploy kind — must match the workflow package directory name. */
  kind: string;
  label: string;
  description: string;
  variants: AbPresetVariant[];
}

function blindVariants(specs: VariantSpec[]): AbPresetVariant[] {
  return specs.map((spec, index) => {
    const variant = typeof spec === "string" ? { model: spec } : spec;
    return {
      label: `Variant ${index + 1}`,
      ...variant,
    };
  });
}

export const QUALITY_PRESET: AbPresetConfig = {
  kind: "ab-compare-quality",
  label: "A/B Compare - Quality",
  description:
    "Run one shared prompt blind across four frontier models (Opus, GPT-5.5, GLM-5.2, Grok-4.5), then pick the winner.",
  variants: blindVariants([
    "claude-opus-4-8",
    "gpt-5.5",
    "glm-5.2",
    "grok-4.5",
  ]),
};

export const SPEED_PRESET: AbPresetConfig = {
  kind: "ab-compare-speed",
  label: "A/B Compare - Speed",
  description:
    "Run one shared prompt blind across four low-latency models (DeepSeek V4 Flash, Gemini 3.5 Flash, Claude Haiku, GPT-5.4 Nano), then pick the winner.",
  variants: blindVariants([
    { model: "deepseek-v4-flash", provider: LLM_PROVIDER },
    { model: "gemini-3.5-flash", provider: LLM_PROVIDER },
    { model: "claude-haiku-4-5", provider: LLM_PROVIDER },
    { model: "gpt-5.4-nano", provider: LLM_PROVIDER },
  ]),
};

export const STANDARD_PRESET: AbPresetConfig = {
  kind: "ab-compare-standard",
  label: "A/B Compare - Standard",
  description:
    "Run one shared prompt blind across four mid-tier models (Sonnet 5, Kimi K2.6, GPT-5.4, Gemini 3.1 Pro), then pick the winner.",
  variants: blindVariants([
    "claude-sonnet-5",
    "kimi-k2.6",
    "gpt-5.4",
    "gemini-3.1-pro",
  ]),
};

export const AB_PRESETS: AbPresetConfig[] = [
  QUALITY_PRESET,
  SPEED_PRESET,
  STANDARD_PRESET,
];
