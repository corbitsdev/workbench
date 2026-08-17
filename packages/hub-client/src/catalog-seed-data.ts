// Declarative dev catalog seed data — pure data, no HTTP. Mirrors
// Interchange's own bin/lib/catalog-seed-data.ts idiom: a plain data
// module `seedCatalog` (see seed.ts) drives through the catalog HTTP
// API, kept importable on its own so nothing here ever grows a network
// dependency.
//
// One small curated model set per `SupportedCredentialProvider`
// (`credential-test.ts`), so whichever provider a person connects during
// onboarding gets a browsable, launchable catalog — not just Anthropic.
// A canonical model name is shared across providers that serve the
// literal same model id (e.g. Anthropic and Opencode Zen both answer to
// `claude-sonnet-5`); `seedCatalog`'s `ensureCatalogModel` already
// dedupes by canonical name, so this never plants the same model twice.

import type {
  AdapterPluginId,
  SupportedCredentialProvider,
} from "./credential-test";

export type CatalogModelSpec = {
  readonly canonicalName: string;
  readonly displayName: string;
};

export type CatalogProviderSpec = {
  readonly name: string;
  readonly plugin: AdapterPluginId;
  readonly baseURL: string;
};

export type CatalogProviderSeed = {
  readonly provider: CatalogProviderSpec;
  /** 2-4 sensible defaults: enough to make the model picker useful,
   * never the provider's entire model list. */
  readonly models: readonly CatalogModelSpec[];
};

export const CATALOG_SEEDS: Readonly<
  Record<SupportedCredentialProvider, CatalogProviderSeed>
> = {
  anthropic: {
    provider: {
      name: "anthropic",
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com",
    },
    models: [
      { canonicalName: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ],
  },
  openai: {
    provider: {
      name: "openai",
      plugin: "openai",
      baseURL: "https://api.openai.com/v1",
    },
    models: [
      { canonicalName: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
      { canonicalName: "gpt-4o-mini", displayName: "GPT-4o mini" },
    ],
  },
  "google-genai": {
    provider: {
      name: "google-genai",
      plugin: "google-genai",
      baseURL: "https://generativelanguage.googleapis.com",
    },
    models: [
      { canonicalName: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
      { canonicalName: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    ],
  },
  xai: {
    provider: {
      name: "xai",
      plugin: "openai-compatible",
      baseURL: "https://api.x.ai/v1",
    },
    models: [
      { canonicalName: "grok-4.6", displayName: "Grok 4.6" },
      { canonicalName: "grok-4.5", displayName: "Grok 4.5" },
      { canonicalName: "grok-code-fast-1", displayName: "Grok Code Fast 1" },
    ],
  },
  openrouter: {
    provider: {
      name: "openrouter",
      plugin: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
    },
    models: [
      {
        canonicalName: "qwen/qwen3.8-27b",
        displayName: "Qwen 3.8 27B (OpenRouter)",
      },
      {
        canonicalName: "anthropic/claude-sonnet-5",
        displayName: "Claude Sonnet 5 (OpenRouter)",
      },
      {
        canonicalName: "openai/gpt-5.6-sol",
        displayName: "GPT-5.6 Sol (OpenRouter)",
      },
      {
        canonicalName: "meta-llama/llama-3.3-70b-instruct",
        displayName: "Llama 3.3 70B (OpenRouter)",
      },
      {
        canonicalName: "google/gemma-4-26b-a4b-it:free",
        displayName: "Gemma 4 26B — free (OpenRouter)",
      },
    ],
  },
  "opencode-zen": {
    provider: {
      name: "opencode-zen",
      plugin: "openai-compatible",
      baseURL: "https://opencode.ai/zen/v1",
    },
    models: [
      { canonicalName: "qwen3.7-plus", displayName: "Qwen 3.7 Plus (Zen)" },
      {
        canonicalName: "claude-sonnet-5",
        displayName: "Claude Sonnet 5 (Zen)",
      },
      { canonicalName: "gpt-5.4-mini", displayName: "GPT-5.4 mini (Zen)" },
      {
        canonicalName: "deepseek-v4-flash",
        displayName: "DeepSeek v4 Flash (Zen)",
      },
      { canonicalName: "kimi-k2.6", displayName: "Kimi K2.6 (Zen)" },
    ],
  },
  groq: {
    provider: {
      name: "groq",
      plugin: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
    },
    models: [
      {
        canonicalName: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B Versatile",
      },
      {
        canonicalName: "llama-3.1-8b-instant",
        displayName: "Llama 3.1 8B Instant",
      },
      { canonicalName: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B" },
    ],
  },
  deepseek: {
    provider: {
      name: "deepseek",
      plugin: "openai-compatible",
      baseURL: "https://api.deepseek.com",
    },
    models: [
      { canonicalName: "deepseek-v4-flash", displayName: "DeepSeek v4 Flash" },
      { canonicalName: "deepseek-v4-pro", displayName: "DeepSeek v4 Pro" },
    ],
  },
  mistral: {
    provider: {
      name: "mistral",
      plugin: "openai-compatible",
      baseURL: "https://api.mistral.ai/v1",
    },
    models: [
      { canonicalName: "mistral-small-2603", displayName: "Mistral Small" },
      { canonicalName: "mistral-large-2512", displayName: "Mistral Large" },
      { canonicalName: "codestral-2508", displayName: "Codestral" },
    ],
  },
  huggingface: {
    provider: {
      name: "huggingface",
      plugin: "openai-compatible",
      baseURL: "https://router.huggingface.co/v1",
    },
    // Curated against the router's live catalog (router.huggingface.co/v1/models):
    // one fast/cheap default, one broadly-known instruct model, one coding model.
    models: [
      {
        canonicalName: "deepseek-ai/DeepSeek-V4-Flash",
        displayName: "DeepSeek V4 Flash (HF Router)",
      },
      {
        canonicalName: "meta-llama/Llama-3.3-70B-Instruct",
        displayName: "Llama 3.3 70B (HF Router)",
      },
      {
        canonicalName: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        displayName: "Qwen3 Coder 30B (HF Router)",
      },
    ],
  },
  ollama: {
    provider: {
      name: "ollama",
      plugin: "openai-compatible",
      // The OpenAI-compatible `/v1` form — what a deployed workflow's
      // `ModelSource.baseURL` actually dials. `baseURLOverride`
      // (`seedCatalog`, `credential-test.ts`'s `ollamaOpenAICompatBaseURL`)
      // replaces this with whatever origin the person actually pointed
      // their instance at; this default is the local-machine origin
      // every onboarding URL field defaults to.
      baseURL: "http://localhost:11434/v1",
    },
    // Curated against a real instance's `/api/tags` (see this ticket's
    // report): whichever of these two the person's own Ollama actually
    // has loaded, `qwen3.8:27b` leads since it is the one confirmed to
    // serve tool calls and thinking.
    models: [
      { canonicalName: "qwen3.8:27b", displayName: "Qwen 3.8 27B (Ollama)" },
      {
        canonicalName: "qwen3.5:9b-mlx",
        displayName: "Qwen 3.5 9B MLX (Ollama)",
      },
    ],
  },
};

/** A single provider/model pair, structurally the shape a channel-host
 * launch's `inference.sources` list carries (`InferencePreference` in
 * `@intx/agent`) — named locally rather than imported so this package,
 * which never launches agents itself, does not need `@intx/agent` as a
 * dependency. */
export type ChannelHostInferencePreference = {
  readonly provider: string;
  readonly model: string;
};

/**
 * Orders a bench's connected providers into a channel-host inference
 * preference list, each entry naming that provider's curated default
 * model (`CATALOG_SEEDS`' first model — the same one onboarding hands a
 * freshly connected provider). The list follows `CATALOG_SEEDS`'
 * declared order, which lists anthropic first; since a connected
 * provider can only appear if `connectedProviders` names it, this
 * naturally keeps anthropic at the head whenever it is one of the
 * connected providers, with no special-casing required here.
 *
 * A name absent from `CATALOG_SEEDS` (nothing this catalog seeds, or a
 * typo) is silently dropped rather than guessed at — only providers
 * this catalog actually curates models for can head a preference list.
 * `connectedProviders` with nothing recognized yields an empty list,
 * which is the honest result: the channel-host launch path already
 * treats an empty preference list as a loud failure rather than a
 * silent dead host.
 */
export function deriveChannelHostInferencePreferences(
  connectedProviders: readonly string[],
): ChannelHostInferencePreference[] {
  const connected = new Set(connectedProviders);
  const preferences: ChannelHostInferencePreference[] = [];
  for (const providerName of Object.keys(
    CATALOG_SEEDS,
  ) as SupportedCredentialProvider[]) {
    if (!connected.has(providerName)) continue;
    const defaultModel = CATALOG_SEEDS[providerName].models[0];
    if (defaultModel === undefined) continue;
    preferences.push({
      provider: providerName,
      model: defaultModel.canonicalName,
    });
  }
  return preferences;
}
