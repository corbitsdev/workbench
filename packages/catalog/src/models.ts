import type { CatalogModelSpec } from "./catalog";

// contextWindow values are models.dev `limit.context` (tokens) for the
// provider that actually serves each model in Workbench — the `opencode`
// (OpenCode Zen) provider for the openai-compatible roster, and the model's
// direct provider (openai/google-ai) for models OpenCode Zen does not serve.
// The window is provider-specific on models.dev, so keying on the wrong
// provider yields a wrong window. Regenerate/verify against
// https://models.dev/api.json with
// `bun run packages/catalog/scripts/regen-from-models-dev.ts`.
const ALL_MODELS: CatalogModelSpec[] = [
  // opencode-zen / anthropic models
  { canonicalName: "claude-fable-5", contextWindow: 1_000_000 },
  { canonicalName: "claude-sonnet-5", contextWindow: 1_000_000 },
  { canonicalName: "claude-sonnet-4-6", contextWindow: 1_000_000 },
  { canonicalName: "claude-opus-4-8", contextWindow: 1_000_000 },
  { canonicalName: "claude-haiku-4-5", contextWindow: 200_000 },
  { canonicalName: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
  // opencode-zen / OpenAI models
  { canonicalName: "gpt-5.5", contextWindow: 1_050_000 },
  { canonicalName: "gpt-5.4", contextWindow: 1_050_000 },
  { canonicalName: "gpt-5.4-mini", contextWindow: 400_000 },
  { canonicalName: "gpt-5.4-nano", contextWindow: 400_000 },
  // OpenAI-direct models (not served by OpenCode Zen)
  { canonicalName: "gpt-4.1", contextWindow: 1_047_576 },
  // opencode-zen / Google models
  { canonicalName: "gemini-3.5-flash", contextWindow: 1_048_576 },
  { canonicalName: "gemini-3.1-pro", contextWindow: 1_048_576 },
  // google-ai-direct models (not served by OpenCode Zen)
  { canonicalName: "gemini-2.5-flash", contextWindow: 1_048_576 },
  { canonicalName: "gemini-2.5-pro", contextWindow: 1_048_576 },
  // opencode-zen / DeepSeek models
  { canonicalName: "deepseek-v4-flash", contextWindow: 1_000_000 },
  { canonicalName: "deepseek-v4-pro", contextWindow: 1_000_000 },
  // opencode-zen / Moonshot models
  { canonicalName: "kimi-k2.6", contextWindow: 262_144 },
  // kimi-k3 is served through OpenRouter; window hand-set from OpenRouter's
  // published 1,048,576-token context (verify against models.dev once listed).
  { canonicalName: "kimi-k3", contextWindow: 1_048_576 },
  // opencode-zen / Zhipu models
  { canonicalName: "glm-5.2", contextWindow: 1_000_000 },
  // opencode-zen / xAI models
  { canonicalName: "grok-4.5", contextWindow: 500_000 },
  // near-ai models (absent from models.dev — conservative hand-set windows)
  {
    canonicalName: "deepseek-ai/DeepSeek-V4-Flash",
    contextWindow: 128_000,
  },
  {
    canonicalName: "near-ai/llama-3.1-70b-instruct",
    contextWindow: 128_000,
  },
  {
    canonicalName: "near-ai/llama-3.3-70b-instruct",
    contextWindow: 128_000,
  },
  {
    canonicalName: "near-ai/qwen-2.5-72b-instruct",
    contextWindow: 32_768,
  },
  { canonicalName: "near-ai/deepseek-r1", contextWindow: 64_000 },
];

// Deduplicate by canonicalName
const seen = new Set<string>();
export const CATALOG_MODELS: CatalogModelSpec[] = ALL_MODELS.filter((m) => {
  if (seen.has(m.canonicalName)) return false;
  seen.add(m.canonicalName);
  return true;
});
