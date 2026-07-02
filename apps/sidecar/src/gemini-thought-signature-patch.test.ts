import { describe, it, expect } from "bun:test";
import {
  buildWorkbenchAdapterRegistry,
  stripThoughtSignatures,
  withGeminiThoughtSignaturePatch,
} from "./gemini-thought-signature-patch";
import { createBuiltinRegistry } from "@intx/inference/providers";

// The strip is the load-bearing logic of the BD-394 workaround: it removes the
// orphan thoughtSignature the google-genai adapter chokes on, before the real
// parser sees the chunk. Otherwise only the key-gated live test exercises it.
describe("stripThoughtSignatures", () => {
  it("removes the orphan signature, leaving a benign empty-text part", () => {
    const chunk = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: "", thoughtSignature: "EjQKMg..." }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
    });
    const parsed = JSON.parse(stripThoughtSignatures(chunk));
    const part = parsed.candidates[0].content.parts[0];
    expect(part.thoughtSignature).toBeUndefined();
    expect(part.text).toBe("");
  });

  it("preserves text, finishReason, and usageMetadata", () => {
    const chunk = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: "hello", thoughtSignature: "sig" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { totalTokenCount: 42 },
    });
    const parsed = JSON.parse(stripThoughtSignatures(chunk));
    expect(parsed.candidates[0].content.parts[0].text).toBe("hello");
    expect(
      parsed.candidates[0].content.parts[0].thoughtSignature,
    ).toBeUndefined();
    expect(parsed.candidates[0].finishReason).toBe("STOP");
    expect(parsed.usageMetadata.totalTokenCount).toBe(42);
  });

  it("strips signatures across multiple parts and candidates", () => {
    const chunk = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "a", thoughtSignature: "x" }, { text: "b" }],
          },
        },
        { content: { parts: [{ text: "c", thoughtSignature: "y" }] } },
      ],
    });
    const parsed = JSON.parse(stripThoughtSignatures(chunk));
    const sigs = parsed.candidates
      .flatMap(
        (c: { content: { parts: { thoughtSignature?: string }[] } }) =>
          c.content.parts,
      )
      .map((p: { thoughtSignature?: string }) => p.thoughtSignature);
    expect(sigs.every((s: unknown) => s === undefined)).toBe(true);
  });

  it("passes non-JSON input through untouched", () => {
    expect(stripThoughtSignatures("[DONE]")).toBe("[DONE]");
    expect(stripThoughtSignatures("not json")).toBe("not json");
  });

  it("passes chunks without candidates or parts through unchanged", () => {
    const noCandidates = JSON.stringify({
      usageMetadata: { totalTokenCount: 1 },
    });
    expect(JSON.parse(stripThoughtSignatures(noCandidates))).toEqual({
      usageMetadata: { totalTokenCount: 1 },
    });
    const noParts = JSON.stringify({ candidates: [{ content: {} }] });
    expect(JSON.parse(stripThoughtSignatures(noParts))).toEqual({
      candidates: [{ content: {} }],
    });
  });
});

// The registry wrap is the delivery mechanism now that upstream removed the
// process-global provider registry: the boot edge passes the wrapped registry
// into createDependencies / the harness builder, so a resolved google-genai
// adapter must strip orphan signatures without any global mutation.
describe("withGeminiThoughtSignaturePatch", () => {
  const geminiSource = {
    sourceId: "src-gemini",
    provider: "google-genai",
    model: "gemini-3.1-flash-lite",
  };

  const orphanSignatureChunk = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: "", thoughtSignature: "EjQKMg..." }],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
  });

  it("the unpatched built-in google-genai adapter rejects the orphan signature (patch still needed)", () => {
    const adapter = createBuiltinRegistry().resolve(geminiSource);
    expect(() => adapter.parseResponse(orphanSignatureChunk)).toThrow();
  });

  it("the wrapped registry's google-genai adapter parses the same chunk", () => {
    const registry = withGeminiThoughtSignaturePatch(createBuiltinRegistry());
    const adapter = registry.resolve(geminiSource);
    expect(() => adapter.parseResponse(orphanSignatureChunk)).not.toThrow();
  });

  it("delegates membership to the inner registry", () => {
    const registry = withGeminiThoughtSignaturePatch(createBuiltinRegistry());
    expect(registry.has("google-genai")).toBe(true);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("not-a-provider")).toBe(false);
  });

  it("leaves non-gemini adapters untouched", () => {
    // A non-gemini adapter must receive the raw chunk, NOT the output of
    // stripThoughtSignatures (which re-serializes JSON and would perturb
    // whitespace/ordering-sensitive payloads).
    const seen: string[] = [];
    const inner = {
      has: (provider: string) => provider === "openai",
      resolve: () => ({
        buildRequest: () => ({ url: "", headers: {}, body: "" }),
        parseResponse: (sseData: string) => {
          seen.push(sseData);
          return [];
        },
      }),
    };
    const registry = withGeminiThoughtSignaturePatch(inner);
    const raw =
      '{"candidates": [{"content": {"parts": [{"thoughtSignature": "x"}]}}]}';
    registry
      .resolve({ ...geminiSource, provider: "openai" })
      .parseResponse(raw);
    expect(seen).toEqual([raw]);
  });
});

// The shared constructor is what the workflow-child's substrate factory calls
// (WORKBENCH-LOCAL CL-2650) — this pins that a child-built registry carries
// the BD-394 wrap, i.e. the child resolves google-genai exactly as the main
// sidecar path does.
describe("buildWorkbenchAdapterRegistry", () => {
  const geminiSource = {
    sourceId: "src-gemini",
    provider: "google-genai",
    model: "gemini-3.1-flash-lite",
  };

  const orphanSignatureChunk = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: "", thoughtSignature: "EjQKMg..." }],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
  });

  it("builds a registry whose google-genai adapter parses an orphan-signature chunk", async () => {
    const registry = await buildWorkbenchAdapterRegistry([]);
    const adapter = registry.resolve(geminiSource);
    expect(() => adapter.parseResponse(orphanSignatureChunk)).not.toThrow();
  });

  it("still resolves the built-in providers", async () => {
    const registry = await buildWorkbenchAdapterRegistry([]);
    expect(registry.has("google-genai")).toBe(true);
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("not-a-provider")).toBe(false);
  });
});
