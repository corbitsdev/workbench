import { describe, expect, test } from "bun:test";
import { suggestRoutineNameFromPrompt } from "./suggest-name";

describe("suggestRoutineNameFromPrompt", () => {
  test("returns a short prompt unchanged, trimmed", () => {
    expect(suggestRoutineNameFromPrompt("  Summarize this week's PRs  ")).toBe(
      "Summarize this week's PRs",
    );
  });

  test("uses only the first line of a multi-line prompt", () => {
    expect(
      suggestRoutineNameFromPrompt(
        "Draft a morning brief\n\nInclude weather and top headlines.",
      ),
    ).toBe("Draft a morning brief");
  });

  test("truncates a long prompt with a trailing ellipsis", () => {
    const prompt =
      "Research every competing launch across the AI coding agent space this month and summarize the differentiators";
    const result = suggestRoutineNameFromPrompt(prompt);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(prompt.startsWith(result.slice(0, -1).trimEnd())).toBe(true);
  });

  test("returns an empty string for whitespace-only input", () => {
    expect(suggestRoutineNameFromPrompt("   \n  ")).toBe("");
  });

  test("truncates on a code-point boundary, never splitting a surrogate pair", () => {
    // Each 🎉 is one code point but two UTF-16 code units — a
    // `.slice`/`.length` truncation at exactly 59 *code units* would cut
    // the 30th emoji in half, leaving an unpaired (invalid) surrogate.
    const prompt = "🎉".repeat(70);
    const result = suggestRoutineNameFromPrompt(prompt);

    expect(result.endsWith("…")).toBe(true);
    const kept = result.slice(0, -1);
    expect(Array.from(kept)).toEqual(Array(59).fill("🎉"));
    expect(kept).toBe("🎉".repeat(59));
    // An unpaired surrogate makes encodeURIComponent throw a URIError —
    // this is the cheapest way to prove no half-emoji leaked through.
    expect(() => encodeURIComponent(result)).not.toThrow();
  });
});
