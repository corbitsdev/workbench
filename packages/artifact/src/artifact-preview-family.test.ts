/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_PREVIEW_FAMILIES,
  artifactPreviewFamily,
  comparisonSummary,
  previewExcerpt,
} from "./artifact-preview-family";

describe("artifactPreviewFamily", () => {
  it("covers every declared family with at least one kind", () => {
    const seen = new Set<string>();
    for (const kind of [
      "one-pager",
      "linkedin-post",
      "email",
      "research",
      "ab-comparison",
      "presentation",
      "csv-export",
      "web",
    ]) {
      seen.add(artifactPreviewFamily(kind));
    }
    for (const family of ARTIFACT_PREVIEW_FAMILIES) {
      expect(seen.has(family)).toBe(true);
    }
  });

  it("maps social and email families distinctly", () => {
    expect(artifactPreviewFamily("twitter-post")).toBe("social");
    expect(artifactPreviewFamily("follow-up-email")).toBe("email");
  });

  it("falls unknown kinds back to document", () => {
    expect(artifactPreviewFamily("future-kind")).toBe("document");
  });
});

describe("previewExcerpt", () => {
  it("truncates long content with an ellipsis", () => {
    const long = "word ".repeat(40);
    const out = previewExcerpt(long, { max: 20 });
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("cleans markdown syntax before truncating", () => {
    expect(previewExcerpt("# Heading\n**bold** text")).toBe(
      "Heading bold text",
    );
  });

  it("resolves JSON content through its summary field instead of raw syntax", () => {
    expect(previewExcerpt('{"summary": "Key finding"}')).toBe("Key finding");
  });

  it("falls back to the artifact title when JSON has no summary field", () => {
    expect(previewExcerpt('{"id": 1}', { fallbackTitle: "Data Export" })).toBe(
      "Data Export",
    );
  });
});

describe("comparisonSummary", () => {
  const VALID = JSON.stringify({
    ranking: [
      { rank: 1, label: "Claude Opus" },
      { rank: 2, label: "GPT-5" },
      { rank: 3, label: "Gemini" },
      { rank: 4, label: "Llama" },
    ],
    variants: [
      { label: "Claude Opus", content: "a" },
      { label: "GPT-5", content: "b" },
      { label: "Gemini", content: "c" },
      { label: "Llama", content: "d" },
    ],
  });

  it("summarizes the winner and variant count", () => {
    expect(comparisonSummary(VALID)).toBe("Winner: Claude Opus · 4 variants");
  });

  it("pluralizes a single variant correctly", () => {
    const single = JSON.stringify({
      ranking: [{ rank: 1, label: "Claude Opus" }],
      variants: [{ label: "Claude Opus", content: "a" }],
    });
    expect(comparisonSummary(single)).toBe("Winner: Claude Opus · 1 variant");
  });

  it("returns undefined for content that is not a valid comparison result", () => {
    expect(comparisonSummary("not json")).toBeUndefined();
    expect(comparisonSummary('{"unrelated": true}')).toBeUndefined();
  });

  it("drops the 'Winner:' prefix and just states the count when no ranking entry is rank 1 (e.g. a tie or an unranked comparison)", () => {
    const noWinner = JSON.stringify({
      ranking: [
        { rank: 2, label: "Claude Opus" },
        { rank: 2, label: "GPT-5" },
      ],
      variants: [
        { label: "Claude Opus", content: "a" },
        { label: "GPT-5", content: "b" },
      ],
    });
    expect(comparisonSummary(noWinner)).toBe("2 variants");
  });
});
