// The `ollama` provider adapter: the built-in OpenAI Chat Completions
// adapter (SSE parsing, retry/pacing header extraction, message
// marshaling — all unmodified), wrapped so `buildRequest` applies
// operator-configured overrides onto the request body before it ships.
//
// Ollama's openai-compatible `/v1/chat/completions` endpoint takes
// `max_tokens` (mapped internally to Ollama's native `num_predict`) but has
// no OpenAI-shaped field for context window — that rides through the
// endpoint's `options` passthrough object as `options.num_ctx`, exactly
// like a native `/api/chat` call. A silently-dropped `num_ctx` (set on the
// wrong field, or as a top-level key the endpoint ignores) is the failure
// mode this adapter exists to rule out. Reasoning effort rides through the
// same `reasoning_effort` field Ollama already recognizes for gpt-oss
// models on this endpoint.
import { createOpenAIAdapter } from "@intx/inference/providers";
import type {
  AdapterFactory,
  BuiltRequest,
  ProviderAdapter,
} from "@intx/inference";
import type { LastCycleSource } from "@intx/types/runtime";

import {
  parseOllamaAdapterConfig,
  resolveOverride,
  type OllamaAdapterOverride,
} from "./overrides";

type OllamaChatBody = {
  options?: Record<string, unknown>;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
};

function applyOverride(
  built: BuiltRequest,
  override: OllamaAdapterOverride,
): BuiltRequest {
  if (
    override.numCtx === undefined &&
    override.maxOutputTokens === undefined &&
    override.reasoningEffort === undefined
  ) {
    return built;
  }
  const body = JSON.parse(built.body) as OllamaChatBody;
  if (override.numCtx !== undefined) {
    body.options = { ...body.options, num_ctx: override.numCtx };
  }
  if (override.maxOutputTokens !== undefined) {
    // The built-in adapter already set whichever of these two fields its
    // quirks resolved to; overwrite that same field rather than assuming
    // one, so the override wins regardless of which one is in play.
    if (body.max_completion_tokens !== undefined) {
      body.max_completion_tokens = override.maxOutputTokens;
    } else {
      body.max_tokens = override.maxOutputTokens;
    }
  }
  if (override.reasoningEffort !== undefined) {
    body.reasoning_effort = override.reasoningEffort;
  }
  return { ...built, body: JSON.stringify(body) };
}

/**
 * `AdapterFactory` for the `ollama` provider key, the named export a
 * `SIDECAR_ADAPTER_MANIFEST` entry points at. `quirks` is this package's
 * own {@link OllamaAdapterConfig} (an `InferenceSource.quirks` bag), not
 * the built-in adapter's `OpenAIQuirks` — the wrapped adapter is
 * constructed with no quirks of its own, so its request/response handling
 * is exactly the shipped default except for this override pass.
 */
export const createOllamaAdapter: AdapterFactory = (
  source: LastCycleSource,
  quirks?: unknown,
): ProviderAdapter => {
  const config = parseOllamaAdapterConfig(quirks);
  const inner = createOpenAIAdapter(source);
  return {
    ...inner,
    buildRequest: (messages, model, options) =>
      applyOverride(
        inner.buildRequest(messages, model, options),
        resolveOverride(config, model),
      ),
  };
};
