import { type } from "arktype";

/**
 * Per-model inference dial capabilities for honest settings UI (CL-3766).
 * Keys are catalog model slugs (e.g. deepseek-v4-flash, kimi-k2.6).
 */

export const InferenceDialKindSchema = type(
  "'hidden' | 'reasoning_effort' | 'temperature' | 'thinking_toggle' | 'thinking_effort'",
);

export type InferenceDialKind =
  | "hidden"
  | "reasoning_effort"
  | "temperature"
  | "thinking_toggle"
  | "thinking_effort";

export type ModelInferenceCapabilities = {
  readonly modelSlug: string;
  readonly creative: InferenceDialKind;
  readonly thinking: InferenceDialKind;
  /** When true, sending temperature and thinking together must be avoided (400). */
  readonly temperatureThinkingExclusive: boolean;
};

const DEEPSEEK_V4_FLASH: ModelInferenceCapabilities = {
  modelSlug: "deepseek-v4-flash",
  creative: "reasoning_effort",
  thinking: "hidden",
  temperatureThinkingExclusive: false,
};

const KIMI_K2_6: ModelInferenceCapabilities = {
  modelSlug: "kimi-k2.6",
  creative: "temperature",
  thinking: "thinking_toggle",
  temperatureThinkingExclusive: true,
};

const CLAUDE_OPUS_4_8: ModelInferenceCapabilities = {
  modelSlug: "claude-opus-4-8",
  creative: "temperature",
  thinking: "thinking_effort",
  temperatureThinkingExclusive: true,
};

const MATRIX: Record<string, ModelInferenceCapabilities> = {
  "deepseek-v4-flash": DEEPSEEK_V4_FLASH,
  "kimi-k2.6": KIMI_K2_6,
  "claude-opus-4-8": CLAUDE_OPUS_4_8,
};

/** Normalize provider-specific model ids to matrix keys when possible. */
export function normalizeModelSlugForCapabilities(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("deepseek") && lower.includes("flash"))
    return "deepseek-v4-flash";
  if (
    lower.includes("kimi") &&
    (lower.includes("k2") || lower.includes("k2.6"))
  )
    return "kimi-k2.6";
  if (lower.includes("opus") && lower.includes("4-8")) return "claude-opus-4-8";
  if (lower.includes("opus") && lower.includes("4.8")) return "claude-opus-4-8";
  return model;
}

export function getModelInferenceCapabilities(
  model: string,
): ModelInferenceCapabilities | undefined {
  const key = normalizeModelSlugForCapabilities(model);
  return MATRIX[key];
}

export function listKnownModelInferenceCapabilities(): ModelInferenceCapabilities[] {
  return Object.values(MATRIX);
}

export const ModelInferenceCapabilitiesSchema = type({
  modelSlug: "string",
  creative: InferenceDialKindSchema,
  thinking: InferenceDialKindSchema,
  temperatureThinkingExclusive: "boolean",
});

export const InferenceCapabilitiesResponseSchema = type({
  models: ModelInferenceCapabilitiesSchema.array(),
});
