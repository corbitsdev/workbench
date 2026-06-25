import { describe, expect, it } from "bun:test";
import { normalizeXResult } from "./normalize";
import type { XSearchResult } from "./types";

describe("normalizeXResult", () => {
  const fixture: XSearchResult = {
    title: "Grok live search is here",
    url: "https://x.com/xai/status/123456",
    summary: "xAI announces live search powered by Grok.",
    publishedAt: "2024-12-01T10:00:00Z",
    engagementSignal: "High engagement, 5k likes",
  };

  it("sets author to x-grok", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.author).toBe("x-grok");
  });

  it("preserves url from fixture", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.url).toBe("https://x.com/xai/status/123456");
  });

  it("preserves title from fixture", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.title).toBe("Grok live search is here");
  });

  it("preserves publishedAt from fixture", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.publishedAt).toBe("2024-12-01T10:00:00Z");
  });

  it("sets source to x", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.source).toBe("x");
  });

  it("sets provenance to degraded", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.provenance).toBe("degraded");
  });

  it("sets score-equivalent engagement to zero", () => {
    const result = normalizeXResult(fixture, "grok live search");
    expect(result.engagement.upvotes).toBe(0);
    expect(result.engagement.comments).toBe(0);
  });

  it("synthesizes x.com search url when url is missing", () => {
    const noUrl: XSearchResult = { ...fixture, url: undefined };
    const result = normalizeXResult(noUrl, "grok live search");
    expect(result.url).toBe("https://x.com/search?q=grok%20live%20search");
  });

  it("synthesizes x.com search url when url is empty string", () => {
    const emptyUrl: XSearchResult = { ...fixture, url: "" };
    const result = normalizeXResult(emptyUrl, "grok live search");
    expect(result.url).toBe("https://x.com/search?q=grok%20live%20search");
  });

  it("falls back to current ISO date when publishedAt is missing", () => {
    const noDate: XSearchResult = { ...fixture, publishedAt: undefined };
    const before = Date.now();
    const result = normalizeXResult(noDate, "grok");
    const after = Date.now();
    const ts = new Date(result.publishedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
