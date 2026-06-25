/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { extractImageURLs } from "./url-image";

describe("extractImageURLs", () => {
  it("extracts a markdown image and removes the syntax", () => {
    const { cleanedText, urls } = extractImageURLs(
      "Here is a chart:\n![chart](https://example.com/chart.png)\nDone.",
    );
    expect(urls).toEqual(["https://example.com/chart.png"]);
    expect(cleanedText).toContain("Here is a chart:");
    expect(cleanedText).not.toContain("![");
  });

  it("extracts a bare image-extension URL on its own line", () => {
    const { cleanedText, urls } = extractImageURLs(
      "See below:\nhttps://cdn.example.com/image.jpg\nEnd.",
    );
    expect(urls).toEqual(["https://cdn.example.com/image.jpg"]);
    expect(cleanedText).not.toContain("https://cdn.example.com/image.jpg");
  });

  it("extracts image URLs with query strings", () => {
    const { cleanedText, urls } = extractImageURLs(
      "![img](https://cdn.example.com/pic.webp?sig=abc123)",
    );
    expect(urls).toEqual(["https://cdn.example.com/pic.webp?sig=abc123"]);
    expect(cleanedText).toBe("");
  });

  it("extracts multiple image URLs from mixed content", () => {
    const text =
      "First:\n![a](https://example.com/a.png)\nSecond:\nhttps://example.com/b.gif\nDone.";
    const { urls } = extractImageURLs(text);
    expect(urls).toHaveLength(2);
    expect(urls).toContain("https://example.com/a.png");
    expect(urls).toContain("https://example.com/b.gif");
  });

  it("does not extract non-image extension URLs", () => {
    const { urls } = extractImageURLs(
      "Visit https://example.com/page and https://example.com/doc.pdf",
    );
    expect(urls).toHaveLength(0);
  });

  it("does not extract markdown link syntax (only image syntax)", () => {
    const { urls } = extractImageURLs(
      "[click here](https://example.com/photo.png)",
    );
    expect(urls).toHaveLength(0);
  });

  it("normalizes excessive blank lines left after removal", () => {
    const { cleanedText } = extractImageURLs(
      "Above\n\n\n![img](https://example.com/a.png)\n\n\nBelow",
    );
    expect(cleanedText).not.toMatch(/\n{3,}/);
  });

  it("returns empty urls and unchanged text when no images present", () => {
    const text = "Hello, world! Here is a link: https://example.com";
    const { cleanedText, urls } = extractImageURLs(text);
    expect(urls).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });

  it("deduplicates the same URL appearing as both markdown and bare", () => {
    const url = "https://example.com/chart.png";
    const { urls } = extractImageURLs(`![chart](${url})\n${url}`);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(url);
  });

  it("supports svg, jpeg, and webp extensions", () => {
    for (const ext of ["svg", "jpeg", "webp"]) {
      const { urls } = extractImageURLs(
        `![x](https://example.com/file.${ext})`,
      );
      expect(urls).toHaveLength(1);
    }
  });
});
