import { describe, it, expect } from "bun:test";
import { stripThoughtSignatures } from "./gemini-thought-signature-patch";

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
        (c: { content: { parts: Array<{ thoughtSignature?: string }> } }) =>
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
