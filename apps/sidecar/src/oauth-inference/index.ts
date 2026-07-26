import type { AdapterFactory, AdapterRegistry } from "@intx/inference";
import type { LastCycleSource } from "@intx/types/runtime";
import {
  CODEX_RESPONSES_PROVIDER,
  createCodexResponsesAdapter,
} from "./codex-responses";
import {
  GROK_RESPONSES_PROVIDER,
  createGrokResponsesAdapter,
} from "./grok-responses";

// Workbench-owned inference adapters for the two user-self-OAuth providers
// (ChatGPT/Codex, xAI/Grok). They live here — NOT in `packages/inference` —
// because that package is vendored from interchange and re-synced wholesale on
// every pin bump: a literal upstream copy would delete the registrations and
// every agent pinned to a `codex-responses` / `grok-responses` source would
// fail to deploy with `Source provider "X" is not registered`. This file uses
// only the public `@intx/inference` surface and plugs in through the same
// registry-wrapping seam as `gemini-thought-signature-patch.ts`, so the
// vendored source stays byte-identical to upstream.

const OAUTH_INFERENCE_FACTORIES: Readonly<Record<string, AdapterFactory>> = {
  [CODEX_RESPONSES_PROVIDER]: createCodexResponsesAdapter,
  [GROK_RESPONSES_PROVIDER]: createGrokResponsesAdapter,
};

/**
 * Wrap a registry so the user-OAuth providers resolve. The inner registry is
 * consulted first, so an operator-configured manifest entry can still override
 * either provider — same precedence custom adapters have over built-ins.
 */
export function withOAuthInferenceAdapters(
  inner: AdapterRegistry,
): AdapterRegistry {
  return {
    has(provider: string): boolean {
      return inner.has(provider) || provider in OAUTH_INFERENCE_FACTORIES;
    },
    resolve(source: LastCycleSource) {
      if (inner.has(source.provider)) return inner.resolve(source);
      const factory = OAUTH_INFERENCE_FACTORIES[source.provider];
      if (factory) return factory(source);
      return inner.resolve(source);
    },
  };
}

export { CODEX_RESPONSES_PROVIDER, createCodexResponsesAdapter };
export { GROK_RESPONSES_PROVIDER, createGrokResponsesAdapter };
