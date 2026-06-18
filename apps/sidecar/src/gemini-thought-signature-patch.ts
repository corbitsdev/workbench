import { createGoogleGenAIAdapter, registerProvider } from '@intx/inference';
import type { ProviderAdapter } from '@intx/inference';

// TEMPORARY local fix for an upstream Interchange bug — tracked in BD-394 /
// internal bug linked.
//
// WHY WE NEED THIS
// The google-genai adapter's `parseResponse` throws ProtocolMismatchError on
// any Gemini 3.x response whose signature-bearing part has no preceding
// thinking block to anchor it (`consumeSignature`, google-genai.ts:1365).
// gemini-3.1-flash-lite's structured-output responses end with an orphan
// `thoughtSignature` part (`{ text: "", thoughtSignature }`), so every such
// call fails even though the model returns a complete, valid JSON payload.
// greybeard validated this as a genuine adapter defect, not caller misuse.
// Without this, the Gemini provider (our preferred inference source) is
// unusable for any structured generate step that uses google-genai.
//
// HOW WE PATCH
// We do not edit the vendored submodule. Interchange exposes a public provider
// registry (`registerProvider`) and the real adapter factory
// (`createGoogleGenAIAdapter`). We register a thin wrapper under the same
// "google-genai" id that delegates to the real adapter but pre-processes each
// streamed SSE chunk: it strips the `thoughtSignature` field from every part
// before the real parser sees it. With no signature present, the orphan-anchor
// branch is never reached, so the parser never throws and the response text
// (the JSON we want) flows through unchanged. We don't round-trip thinking
// signatures for our use cases, so dropping them is lossless.
//
// SCOPE & REMOVAL
// `registerProvider` mutates a process-wide registry, so this affects all
// google-genai inference in the process once installed (intended). It is
// idempotent. Remove this file, its call in index.ts, and the test file once
// BD-394 is fixed upstream and the vendored Interchange commit is bumped.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

let installed = false;

export function installGeminiThoughtSignaturePatch(): void {
  if (installed) return;
  installed = true;
  registerProvider('google-genai', (source): ProviderAdapter => {
    const inner = createGoogleGenAIAdapter(source);
    return {
      ...inner,
      parseResponse: (sseData) => inner.parseResponse(stripThoughtSignatures(sseData)),
    };
  });
}
