/**
 * Literal union of `@intx/inference-catalog`'s `catalogModels` canonical
 * names. The catalog exports that list as a plain (non-const) array, so
 * TypeScript can't derive a literal type from it directly — this union is
 * hand-listed and kept honest by `catalog-models.test.ts`, which fails the
 * moment it drifts from the live `catalogModels` export. Assigning a typo'd
 * or made-up model id to a `CatalogModelName`-typed field is a compile
 * error, not a silent `lookupRates` miss.
 */
export type CatalogModelName =
  | "claude-sonnet-5"
  | "claude-opus-5"
  | "claude-haiku-4-5-20251001"
  | "gpt-5.5"
  | "gpt-5.6-sol"
  | "gemini-2.5-pro"
  | "gemini-3.6-flash"
  | "kimi-k3"
  | "kimi-k2.7-code"
  | "claude-fable-5"
  | "claude-opus-4-8"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-sonnet-4-5-20250929"
  | "claude-sonnet-4-6"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gemini-2.5-flash"
  | "gemini-3.5-flash"
  | "gemini-2.5-flash-image"
  | "gemini-3.1-flash-image"
  | "gemini-3-flash-preview"
  | "gemini-3.1-pro-preview"
  | "kimi-k2.6"
  | "qwen3.7-plus"
  | "mimo-v2.5"
  | "glm-5.2"
  | "gpt-5.4-mini"
  | "deepseek-v4-pro"
  | "deepseek-v4-flash"
  | "glm-5"
  | "glm-5.1"
  | "hy3"
  | "kimi-k2.5"
  | "mimo-v2.5-pro"
  | "minimax-m2.5"
  | "minimax-m2.7"
  | "minimax-m3"
  | "qwen3.5-plus"
  | "qwen3.6-plus"
  | "qwen3.7-max"
  | "qwen3.8-max"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.4"
  | "gpt-5.4-nano"
  | "o1"
  | "o3"
  | "o3-mini"
  | "o4-mini"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "gpt-4"
  | "grok-4.20-0309-non-reasoning"
  | "grok-4.20-0309-reasoning"
  | "grok-4.3"
  | "grok-4.5"
  | "grok-4.6"
  | "grok-build-0.1";

export const CATALOG_MODEL_NAMES: readonly CatalogModelName[] = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gemini-2.5-pro",
  "gemini-3.6-flash",
  "kimi-k3",
  "kimi-k2.7-code",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-2.5-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "kimi-k2.6",
  "qwen3.7-plus",
  "mimo-v2.5",
  "glm-5.2",
  "gpt-5.4-mini",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5",
  "glm-5.1",
  "hy3",
  "kimi-k2.5",
  "mimo-v2.5-pro",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.8-max",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-nano",
  "o1",
  "o3",
  "o3-mini",
  "o4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-4.3",
  "grok-4.5",
  "grok-4.6",
  "grok-build-0.1",
];
