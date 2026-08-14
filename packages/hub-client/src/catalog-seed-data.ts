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
    models: [{ canonicalName: "gpt-4o-mini", displayName: "GPT-4o mini" }],
  },
  "google-genai": {
    provider: {
      name: "google-genai",
      plugin: "google-genai",
      baseURL: "https://generativelanguage.googleapis.com",
    },
    models: [
      { canonicalName: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
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
};
