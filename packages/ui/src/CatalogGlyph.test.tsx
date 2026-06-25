import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import {
  CATALOG_GLYPH_FILLS,
  CATALOG_GLYPH_KINDS,
  CatalogGlyph,
  catalogCardClassName,
  hashString,
} from "./CatalogGlyph";

describe("hashString", () => {
  it("is deterministic for the same input", () => {
    expect(hashString("granola_summary")).toBe(hashString("granola_summary"));
  });

  it("differs across distinct inputs", () => {
    expect(hashString("exa_search")).not.toBe(hashString("firecrawl_scrape"));
  });

  it("returns a non-negative integer usable as an array index", () => {
    const h = hashString("anything");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe("CatalogGlyph", () => {
  it("renders the doc glyph as five bars", () => {
    const { container } = render(<CatalogGlyph kind="doc" />);
    expect(container.querySelectorAll("rect")).toHaveLength(5);
  });

  it("renders the grid glyph as fifteen cells", () => {
    const { container } = render(<CatalogGlyph kind="grid" />);
    expect(container.querySelectorAll("rect")).toHaveLength(15);
  });

  it("renders the nodes glyph with four circles", () => {
    const { container } = render(<CatalogGlyph kind="nodes" />);
    expect(container.querySelectorAll("circle")).toHaveLength(4);
  });

  it("renders the code glyph as strokes only (no rects)", () => {
    const { container } = render(<CatalogGlyph kind="code" />);
    expect(container.querySelectorAll("rect")).toHaveLength(0);
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });
});

describe("catalog tile styling", () => {
  it("gates the lift transforms behind a fine-pointer media query", () => {
    expect(catalogCardClassName).toContain(
      "[@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-1.5",
    );
    // The bare hover transform (the touch-device bug) must not be present.
    expect(catalogCardClassName).not.toContain(" hover:-translate-y-1.5");
  });

  it("exposes matching kind and fill option counts for index-based selection", () => {
    expect(CATALOG_GLYPH_KINDS).toHaveLength(4);
    expect(CATALOG_GLYPH_FILLS).toHaveLength(4);
  });
});
