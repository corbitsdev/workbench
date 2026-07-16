import { type } from "arktype";
import type { InferenceOptions } from "@intx/types/runtime";
import {
  getModelInferenceCapabilities,
  type ModelInferenceCapabilities,
} from "./inference-capabilities";
import { resolveInferenceParamsMarker } from "./inference-params-marker";

/** Member dial 0–100; `null` means model default. */
export type InferenceDialValue = number | null;

export type ResolvedInferenceDials = {
  readonly model: string;
  readonly creative: InferenceDialValue;
  readonly thinking: InferenceDialValue;
};

export const INFERENCE_PARAMS_ENV_KEY = "@workbench/myra/inference-params";

const ResolvedInferenceDialsSchema = type({
  model: "string",
  creative: "number | null",
  thinking: "number | null",
});

export function readInferenceParamsFromEnv(
  env: unknown,
): ResolvedInferenceDials | undefined {
  const value = (env as Record<string, unknown>)[INFERENCE_PARAMS_ENV_KEY];
  const parsed = ResolvedInferenceDialsSchema(value);
  if (parsed instanceof type.errors) return undefined;
  return parsed;
}

/** Env override first; else the launch-time control-plane marker on the system prompt. */
export function readInferenceParamsForDirector(
  env: unknown,
  systemPrompt: string,
): ResolvedInferenceDials | undefined {
  return (
    readInferenceParamsFromEnv(env) ??
    resolveInferenceParamsMarker(systemPrompt)
  );
}

type ReasoningEffort = "low" | "medium" | "high";

function clampDial(value: InferenceDialValue): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** DeepSeek: API defaults high; UI low/medium map up to avoid weak outputs. */
function mapCreativeToReasoningEffort(dial: number | null): ReasoningEffort {
  if (dial === null) return "high";
  if (dial <= 33) return "medium";
  if (dial <= 66) return "high";
  return "high";
}

function mapCreativeToTemperature(dial: number | null): number {
  if (dial === null) return 1;
  return 0.2 + (dial / 100) * 0.8;
}

function thinkingEnabled(dial: number | null, defaultOn: boolean): boolean {
  if (dial === null) return defaultOn;
  return dial >= 50;
}

function mapThinkingToAnthropicEffort(
  dial: number | null,
): "low" | "medium" | "high" {
  if (dial === null) return "high";
  if (dial <= 33) return "low";
  if (dial <= 66) return "medium";
  return "high";
}

function isKimiModel(model: string): boolean {
  const caps = getModelInferenceCapabilities(model);
  return caps?.modelSlug === "kimi-k2.6";
}

function isOpusModel(model: string): boolean {
  const caps = getModelInferenceCapabilities(model);
  return caps?.modelSlug === "claude-opus-4-8";
}

function isDeepseekFlash(model: string): boolean {
  const caps = getModelInferenceCapabilities(model);
  return caps?.modelSlug === "deepseek-v4-flash";
}

/**
 * Map member dials + model capabilities to per-call inference options.
 * Encodes 400-avoidance: never send temperature with thinking when exclusive.
 */
export function resolveInferenceOptionsFromDials(
  dials: ResolvedInferenceDials,
): Partial<InferenceOptions> {
  const creative = clampDial(dials.creative);
  const thinking = clampDial(dials.thinking);
  const caps = getModelInferenceCapabilities(dials.model);

  if (!caps) {
    if (creative !== null) {
      return { temperature: mapCreativeToTemperature(creative) };
    }
    return {};
  }

  return applyForCapabilities(dials.model, caps, creative, thinking);
}

function patchOmitsTemperatureForExclusiveThinking(
  patch: Partial<InferenceOptions>,
): boolean {
  if (patch.thinking?.enabled === true) return true;
  const po = patch.providerOptions;
  if (
    po !== undefined &&
    typeof po === "object" &&
    po !== null &&
    "thinking" in po
  ) {
    const thinking = (po as Record<string, unknown>)["thinking"];
    if (
      typeof thinking === "object" &&
      thinking !== null &&
      (thinking as Record<string, unknown>)["type"] === "enabled"
    ) {
      return true;
    }
  }
  return false;
}

function applyForCapabilities(
  model: string,
  caps: ModelInferenceCapabilities,
  creative: number | null,
  thinking: number | null,
): Partial<InferenceOptions> {
  if (isDeepseekFlash(model)) {
    const effort = mapCreativeToReasoningEffort(creative);
    return {
      providerOptions: { reasoning_effort: effort },
    };
  }

  if (isKimiModel(model)) {
    const thinkOn = thinkingEnabled(thinking, false);
    const providerOptions: Record<string, unknown> = thinkOn
      ? { thinking: { type: "enabled" } }
      : { thinking: { type: "disabled" } };
    if (!thinkOn) {
      return {
        temperature: mapCreativeToTemperature(creative),
        providerOptions,
      };
    }
    return { providerOptions };
  }

  if (isOpusModel(model)) {
    const thinkOn = thinkingEnabled(thinking, false);
    if (thinkOn) {
      const effort = mapThinkingToAnthropicEffort(thinking);
      return {
        thinking: { enabled: true },
        providerOptions: { anthropicThinkingEffort: effort },
      };
    }
    return {
      temperature: mapCreativeToTemperature(creative),
    };
  }

  void caps;
  if (creative !== null) {
    return { temperature: mapCreativeToTemperature(creative) };
  }
  return {};
}

export function mergeInferenceOptions(
  base: InferenceOptions | undefined,
  patch: Partial<InferenceOptions>,
): InferenceOptions {
  const merged: InferenceOptions = { ...(base ?? {}) };
  if (patch.maxTokens !== undefined) merged.maxTokens = patch.maxTokens;
  if (patch.temperature !== undefined) {
    merged.temperature = patch.temperature;
  } else if (patchOmitsTemperatureForExclusiveThinking(patch)) {
    delete merged.temperature;
  }
  if (patch.thinking !== undefined) merged.thinking = patch.thinking;
  if (patch.systemPrompt !== undefined)
    merged.systemPrompt = patch.systemPrompt;
  if (patch.tools !== undefined) merged.tools = patch.tools;
  if (patch.responseModalities !== undefined) {
    merged.responseModalities = patch.responseModalities;
  }
  if (patch.responseFormat !== undefined)
    merged.responseFormat = patch.responseFormat;
  if (patch.providerOptions !== undefined) {
    merged.providerOptions = {
      ...(merged.providerOptions ?? {}),
      ...patch.providerOptions,
    };
  }
  if (patch.inactivityTimeoutMs !== undefined) {
    merged.inactivityTimeoutMs = patch.inactivityTimeoutMs;
  }
  return merged;
}
