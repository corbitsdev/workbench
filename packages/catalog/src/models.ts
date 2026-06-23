import type { CatalogModelSpec } from './catalog';

const ALL_MODELS: CatalogModelSpec[] = [
  // opencode-zen models
  { canonicalName: 'deepseek-v4-flash' },
  { canonicalName: 'deepseek-v3' },
  { canonicalName: 'deepseek-r1' },
  { canonicalName: 'claude-sonnet-4-6' },
  { canonicalName: 'claude-opus-4-8' },
  { canonicalName: 'claude-haiku-4-5-20251001' },
  { canonicalName: 'gpt-4o' },
  { canonicalName: 'gpt-4o-mini' },
  { canonicalName: 'gemini-2.0-flash' },
  { canonicalName: 'o3' },
  { canonicalName: 'o4-mini' },
  // OpenAI-only models
  { canonicalName: 'gpt-4.1' },
  // near-ai models
  { canonicalName: 'near-ai/llama-3.1-70b-instruct' },
  { canonicalName: 'near-ai/llama-3.3-70b-instruct' },
  { canonicalName: 'near-ai/qwen-2.5-72b-instruct' },
  { canonicalName: 'near-ai/deepseek-r1' },
  // google-ai-only models
  { canonicalName: 'gemini-2.5-flash' },
  { canonicalName: 'gemini-2.5-pro' },
];

// Deduplicate by canonicalName
const seen = new Set<string>();
export const CATALOG_MODELS: CatalogModelSpec[] = ALL_MODELS.filter((m) => {
  if (seen.has(m.canonicalName)) return false;
  seen.add(m.canonicalName);
  return true;
});
