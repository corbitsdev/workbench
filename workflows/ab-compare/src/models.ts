export const AB_COMPARISON_PROVIDER_PLUGINS = [
  "anthropic",
  "openai-compatible",
  "openai",
  "google-genai",
] as const;

export type AbComparisonProviderPlugin =
  (typeof AB_COMPARISON_PROVIDER_PLUGINS)[number];

/** Anthropic Messages API — https://platform.claude.com/docs/en/about-claude/models/overview */
export const ANTHROPIC_AB_COMPARISON_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/**
 * OpenCode Zen models routed through `https://opencode.ai/zen/v1/chat/completions`.
 * Excludes `*-free` variants and models on other Zen endpoints (responses/messages).
 * @see https://opencode.ai/docs/zen#endpoints
 */
export const OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS = [
  "kimi-k2.6",
  "glm-5.1",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-k2.5",
  "minimax-m2.7",
  "minimax-m2.5",
  "grok-build-0.1",
  "big-pickle",
  "glm-5",
] as const;

/** OpenAI Responses API frontier text models — https://developers.openai.com/api/docs/models */
export const OPENAI_AB_COMPARISON_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

/** Google Gemini API text models — https://ai.google.dev/gemini-api/docs/models */
export const GOOGLE_GENAI_AB_COMPARISON_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
] as const;

/** Near AI cloud-api models — https://cloud-api.near.ai/v1 */
export const NEAR_AI_MODELS = ["deepseek-ai/DeepSeek-V4-Flash"] as const;

export const AB_COMPARISON_MODELS_BY_PLUGIN: Record<
  AbComparisonProviderPlugin,
  readonly string[]
> = {
  anthropic: ANTHROPIC_AB_COMPARISON_MODELS,
  "openai-compatible": OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS,
  openai: OPENAI_AB_COMPARISON_MODELS,
  "google-genai": GOOGLE_GENAI_AB_COMPARISON_MODELS,
};

/**
 * Per-credential-name overrides. Takes precedence over plugin-level lookup so
 * providers that share a plugin (e.g. near-ai and opencode-zen are both
 * openai-compatible) each expose their own model list.
 */
export const AB_COMPARISON_MODELS_BY_PROVIDER_NAME: Record<
  string,
  readonly string[]
> = {
  "near-ai": NEAR_AI_MODELS,
};

export function listAbComparisonModels(
  providerName: string,
  providerPlugin: string,
): readonly string[] {
  if (providerName in AB_COMPARISON_MODELS_BY_PROVIDER_NAME) {
    return AB_COMPARISON_MODELS_BY_PROVIDER_NAME[providerName]!;
  }
  if (!(providerPlugin in AB_COMPARISON_MODELS_BY_PLUGIN)) return [];
  return AB_COMPARISON_MODELS_BY_PLUGIN[
    providerPlugin as AbComparisonProviderPlugin
  ];
}

export function defaultAbComparisonModel(
  providerName: string,
  providerPlugin: string,
): string | undefined {
  return listAbComparisonModels(providerName, providerPlugin)[0];
}

export function isAbComparisonModelAllowed(
  providerName: string,
  providerPlugin: string,
  model: string,
): boolean {
  return listAbComparisonModels(providerName, providerPlugin).includes(model);
}

export function validateAbComparisonProviders(
  providers: {
    providerName?: string;
    providerPlugin?: string;
    model?: string;
  }[],
): { valid: true } | { valid: false; error: string } {
  if (providers.length < 2) {
    return { valid: false, error: "At least two providers are required" };
  }

  for (let i = 0; i < providers.length; i++) {
    const entry = providers[i];
    const name = entry?.providerName ?? "";
    const plugin = entry?.providerPlugin;
    const model = entry?.model;
    if (!plugin || !model) {
      return {
        valid: false,
        error: `Comparison ${i + 1} requires a provider and model`,
      };
    }
    if (!isAbComparisonModelAllowed(name, plugin, model)) {
      return {
        valid: false,
        error: `Model ${model} is not allowed for ${name || plugin}`,
      };
    }
  }

  return { valid: true };
}
