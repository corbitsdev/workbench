import type { CatalogModelSpec } from './catalog';

const ALL_MODELS: CatalogModelSpec[] = [
  // opencode-zen / anthropic models
  { canonicalName: 'claude-fable-5' },
  { canonicalName: 'claude-sonnet-4-6' },
  { canonicalName: 'claude-opus-4-8' },
  { canonicalName: 'claude-haiku-4-5-20251001' },
  // opencode-zen / OpenAI models
  { canonicalName: 'gpt-5.5' },
  { canonicalName: 'gpt-5.4' },
  { canonicalName: 'gpt-5.4-mini' },
  // OpenAI-only models
  { canonicalName: 'gpt-4.1' },
  // opencode-zen / Google models
  { canonicalName: 'gemini-3.5-flash' },
  // google-ai models
  { canonicalName: 'gemini-3.1-pro' },
  { canonicalName: 'gemini-2.5-flash' },
  { canonicalName: 'gemini-2.5-pro' },
  // opencode-zen / DeepSeek models
  { canonicalName: 'deepseek-v4-flash' },
  { canonicalName: 'deepseek-v4-pro' },
  // opencode-zen / Moonshot models
  { canonicalName: 'kimi-k2.6' },
  // near-ai models
  { canonicalName: 'near-ai/llama-3.1-70b-instruct' },
  { canonicalName: 'near-ai/llama-3.3-70b-instruct' },
  { canonicalName: 'near-ai/qwen-2.5-72b-instruct' },
  { canonicalName: 'near-ai/deepseek-r1' },
];

// Deduplicate by canonicalName
const seen = new Set<string>();
export const CATALOG_MODELS: CatalogModelSpec[] = ALL_MODELS.filter((m) => {
  if (seen.has(m.canonicalName)) return false;
  seen.add(m.canonicalName);
  return true;
});
