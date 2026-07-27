import type { AdapterManifest, AdapterRegistry } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { LastCycleSource } from "@intx/types/runtime";
import { withOAuthInferenceAdapters } from "./oauth-inference";

// TEMPORARY local fix for an upstream Interchange bug — tracked in BD-394 /
// internal bug linked.
//
// WHY WE NEED THIS
// The google-genai adapter's `parseResponse` throws ProtocolMismatchError on
// any Gemini 3.x response whose signature-bearing part has no preceding
// thinking block to anchor it (`consumeSignature`, google-genai.ts). Some
// Gemini structured-output responses end with an orphan `thoughtSignature`
// part (`{ text: "", thoughtSignature }`), so every such call fails even
// though the model returns a complete, valid JSON payload. Without this, the
// Gemini provider is unusable for any structured generate step that uses
// google-genai.
//
// HOW WE PATCH
// Upstream removed the process-global provider registry
// (`registerProvider`/`hasProvider`); adapters now resolve through an
// explicit `AdapterRegistry` built once at the sidecar's boot edge and
// threaded into every consumer (harness builder, agent env deps). We wrap
// that registry: `resolve()` delegates to the inner registry, and for
// "google-genai" sources the returned adapter's `parseResponse` first strips
// the `thoughtSignature` field from every part of the SSE chunk. With no
// signature present, the orphan-anchor branch is never reached, so the parser
// never throws and the response text (the JSON we want) flows through
// unchanged. We don't round-trip thinking signatures for our use cases, so
// dropping them is lossless.
//
// SCOPE & REMOVAL
// The wrapped registry is the ONLY registry the sidecar passes into
// `createDependencies` / the harness builder, so this affects all
// google-genai inference resolved through it (intended). Remove this file,
// its use in index.ts, and the test file once BD-394 is fixed upstream and
// the vendored Interchange commit is bumped.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Exported for hermetic testing — this is the load-bearing logic of the
// workaround, otherwise only exercised by the key-gated live test.
export function stripThoughtSignatures(sseData: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    return sseData; // non-JSON control lines pass through untouched
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return sseData;
  for (const candidate of parsed.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (isRecord(part)) delete part.thoughtSignature;
    }
  }
  return JSON.stringify(parsed);
}

/**
 * Wrap an adapter registry so every resolved "google-genai" adapter strips
 * orphan thought signatures before parsing. All other providers resolve
 * through untouched.
 */
/**
 * The single construction path for every workbench adapter registry —
 * the sidecar's boot edge AND the workflow-child (via the substrate
 * factory) both build through this, so the BD-394 gemini workaround is
 * applied identically on both sides. Remove alongside the wrap once
 * fixed upstream.
 *
 * It also layers in the Workbench-owned user-OAuth inference adapters
 * (`codex-responses`, `grok-responses`) — see `./oauth-inference` for why
 * they cannot live in the vendored `packages/inference` provider set.
 */
export async function buildWorkbenchAdapterRegistry(
  manifest: AdapterManifest,
): Promise<AdapterRegistry> {
  return withGeminiThoughtSignaturePatch(
    withOAuthInferenceAdapters(await loadAdapterRegistry(manifest)),
  );
}

export function withGeminiThoughtSignaturePatch(
  inner: AdapterRegistry,
): AdapterRegistry {
  return {
    has(provider: string): boolean {
      return inner.has(provider);
    },
    resolve(source: LastCycleSource) {
      const adapter = inner.resolve(source);
      if (source.provider !== "google-genai") return adapter;
      return {
        ...adapter,
        parseResponse: (sseData: string) =>
          adapter.parseResponse(stripThoughtSignatures(sseData)),
      };
    },
  };
}
