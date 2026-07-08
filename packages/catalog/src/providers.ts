import type { CatalogProviderSpec } from "./catalog";

export const CATALOG_PROVIDERS: CatalogProviderSpec[] = [
  {
    name: "opencode-zen",
    plugin: "openai-compatible",
    credentialName: "opencode-zen",
    modelsDevProviderId: "opencode",
  },
  {
    name: "anthropic-api",
    plugin: "anthropic",
    credentialName: "anthropic-api",
  },
  { name: "OpenAI", plugin: "openai", credentialName: "OpenAI" },
  { name: "google-ai", plugin: "google-genai", credentialName: "google-ai" },
  { name: "near-ai", plugin: "openai-compatible", credentialName: "near-ai" },
  { name: "Myra LLM", plugin: "openai-compatible", credentialName: "Myra LLM" },
  { name: "bifrost", plugin: "openai-compatible", credentialName: "Bifrost" },
  {
    name: "openrouter",
    plugin: "openai-compatible",
    credentialName: "openrouter",
    modelsDevProviderId: "openrouter",
  },
];
