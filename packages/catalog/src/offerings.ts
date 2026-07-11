import type { CatalogOfferingSpec } from "./catalog";

// Source-resolution priority per provider (lower = head/default; the rest form
// the automatic failover tail). Bifrost is the single head (1) for every model
// it proxies; the openai-compatible directs (opencode-zen, near-ai) are the
// first fallback (2) — matching the wire format agents resolve through today —
// and the native directs (anthropic-api, OpenAI, google-ai) are the deepest
// fallback (3). See @intx/db resolveModelSources.
const OFFERING_PRIORITY: Record<string, number> = {
  "corbits-default-bifrost": 1,
  "corbits-default-bifrost-anthropic": 1,
  "corbits-default-bifrost-genai": 1,
  "opencode-zen": 2,
  "near-ai": 2,
  "anthropic-api": 3,
  OpenAI: 3,
  "google-ai": 3,
};

function offering(model: string, provider: string): CatalogOfferingSpec {
  const priority = OFFERING_PRIORITY[provider];
  if (priority === undefined) {
    throw new Error(`no OFFERING_PRIORITY for provider "${provider}"`);
  }
  return { model, provider, priority };
}

// Each model gets exactly ONE Bifrost head — `bifrost /v1` where the model has
// an openai-compatible offering (its current head wire format), or the matching
// native surface where the model is native-only. The existing providers stay as
// the fallback tier.
export const CATALOG_OFFERINGS: CatalogOfferingSpec[] = [
  offering("claude-fable-5", "corbits-default-bifrost"),
  offering("claude-fable-5", "opencode-zen"),
  offering("claude-fable-5", "anthropic-api"),
  offering("claude-sonnet-5", "corbits-default-bifrost"),
  offering("claude-sonnet-5", "opencode-zen"),
  offering("claude-sonnet-5", "anthropic-api"),
  offering("claude-sonnet-4-6", "corbits-default-bifrost"),
  offering("claude-sonnet-4-6", "opencode-zen"),
  offering("claude-sonnet-4-6", "anthropic-api"),
  offering("claude-opus-4-8", "corbits-default-bifrost"),
  offering("claude-opus-4-8", "opencode-zen"),
  offering("claude-opus-4-8", "anthropic-api"),
  offering("claude-haiku-4-5", "corbits-default-bifrost"),
  offering("claude-haiku-4-5", "opencode-zen"),
  // Native-anthropic-only model — its single Bifrost head is the /anthropic surface.
  offering("claude-haiku-4-5-20251001", "corbits-default-bifrost-anthropic"),
  offering("claude-haiku-4-5-20251001", "anthropic-api"),
  offering("gpt-5.5", "corbits-default-bifrost"),
  offering("gpt-5.5", "opencode-zen"),
  offering("gpt-5.5", "OpenAI"),
  offering("gpt-5.4", "corbits-default-bifrost"),
  offering("gpt-5.4", "opencode-zen"),
  offering("gpt-5.4", "OpenAI"),
  offering("gpt-5.4-mini", "corbits-default-bifrost"),
  offering("gpt-5.4-mini", "opencode-zen"),
  offering("gpt-5.4-mini", "OpenAI"),
  offering("gpt-5.4-nano", "corbits-default-bifrost"),
  offering("gpt-5.4-nano", "opencode-zen"),
  offering("gpt-4.1", "corbits-default-bifrost"),
  offering("gpt-4.1", "OpenAI"),
  offering("gemini-3.5-flash", "corbits-default-bifrost"),
  offering("gemini-3.5-flash", "opencode-zen"),
  offering("gemini-3.5-flash", "google-ai"),
  offering("gemini-3.1-pro", "corbits-default-bifrost"),
  offering("gemini-3.1-pro", "opencode-zen"),
  offering("gemini-3.1-pro", "google-ai"),
  // Native-genai-only models — their single Bifrost head is the /genai surface.
  offering("gemini-2.5-flash", "corbits-default-bifrost-genai"),
  offering("gemini-2.5-flash", "google-ai"),
  offering("gemini-2.5-pro", "corbits-default-bifrost-genai"),
  offering("gemini-2.5-pro", "google-ai"),
  offering("deepseek-v4-flash", "corbits-default-bifrost"),
  offering("deepseek-v4-flash", "opencode-zen"),
  offering("deepseek-v4-pro", "corbits-default-bifrost"),
  offering("deepseek-v4-pro", "opencode-zen"),
  offering("kimi-k2.6", "corbits-default-bifrost"),
  offering("kimi-k2.6", "opencode-zen"),
  offering("glm-5.2", "corbits-default-bifrost"),
  offering("glm-5.2", "opencode-zen"),
  offering("grok-4.5", "corbits-default-bifrost"),
  offering("grok-4.5", "opencode-zen"),
  // near-ai-only models: Bifrost is not configured to proxy these, so they keep
  // near-ai as their sole source.
  offering("deepseek-ai/DeepSeek-V4-Flash", "near-ai"),
  offering("near-ai/llama-3.1-70b-instruct", "near-ai"),
  offering("near-ai/llama-3.3-70b-instruct", "near-ai"),
  offering("near-ai/qwen-2.5-72b-instruct", "near-ai"),
  offering("near-ai/deepseek-r1", "near-ai"),
];
