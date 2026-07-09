// The curated A/B preset line-ups. Each preset runs a shared prompt across four
// FIXED models, then a human picks the winner. `label` is the BLIND label the
// reviewer sees during the decision (the model identity is revealed only in the
// saved artifact); `model` is the catalog canonical name resolved at deploy.
//
// v1 runs every model through opencode-zen (the openai-compatible gateway), so
// the step declares no provider and the default `openai-compatible` plugin
// resolves the opencode-zen offering. Native-provider primaries with a
// opencode-zen fallback are a follow-up (CL-3080).

export interface AbPresetVariant {
  /** Blind label shown to the reviewer, e.g. "Variant 1". */
  label: string;
  /** Catalog canonical model name, resolved at deploy. */
  model: string;
}

export interface AbPresetConfig {
  /** Deploy kind — must match the workflow package directory name. */
  kind: string;
  label: string;
  description: string;
  variants: AbPresetVariant[];
}

function blindVariants(models: string[]): AbPresetVariant[] {
  return models.map((model, index) => ({
    label: `Variant ${index + 1}`,
    model,
  }));
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
    "deepseek-v4-flash",
    "gemini-3.5-flash",
    "claude-haiku-4-5-20251001",
    "gpt-5.4-nano",
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
