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
  // Bifrost gateway, one provider row per wire format on the same instance and
  // virtual key. Owner-prefixed so a customer workbench can shadow with its own
  // <customer>-bifrost* rows. openai-compatible → /v1, anthropic → /anthropic,
  // google-genai → /genai.
  {
    name: "corbits-default-bifrost",
    plugin: "openai-compatible",
    credentialName: "Corbits Default Bifrost",
  },
  {
    name: "corbits-default-bifrost-anthropic",
    plugin: "anthropic",
    credentialName: "Corbits Default Bifrost Anthropic",
  },
  {
    name: "corbits-default-bifrost-genai",
    plugin: "google-genai",
    credentialName: "Corbits Default Bifrost GenAI",
  },
  {
    // credentialName must match the OpenRouter credential the Owner creates from
    // the Capabilities page, which is named after the governance entry's label
    // ("OpenRouter"). OpenRouter has no env seed, so this Owner-set credential is
    // the only one seed-catalog can bind the provider to.
    name: "openrouter",
    plugin: "openai-compatible",
    credentialName: "OpenRouter",
    modelsDevProviderId: "openrouter",
  },
];
