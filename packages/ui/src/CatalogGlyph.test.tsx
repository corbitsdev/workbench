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

  it("gates its hover scale behind a fine-pointer media query", () => {
    const { container } = render(<CatalogGlyph kind="doc" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain(
      "[@media(hover:hover)_and_(pointer:fine)]:group-hover:scale-[1.06]",
    );
    // The bare group-hover scale (the touch-device bug) must not be present.
    expect(wrapper?.className).not.toContain(" group-hover:scale-[1.06]");
  });
});

describe("catalog tile styling", () => {
  it("gates every lift transform behind a fine-pointer media query", () => {
    const gate = "[@media(hover:hover)_and_(pointer:fine)]:hover:";
    for (const transform of [
      "-translate-y-1.5",
      "rotate-[-1deg]",
      "scale-[1.02]",
    ]) {
      expect(catalogCardClassName).toContain(`${gate}${transform}`);
      // No bare (ungated) hover transform — that was the touch-device bug.
      expect(catalogCardClassName).not.toContain(` hover:${transform}`);
    }
  });

  it("exposes matching kind and fill option counts for index-based selection", () => {
    expect(CATALOG_GLYPH_KINDS).toHaveLength(4);
    expect(CATALOG_GLYPH_FILLS).toHaveLength(4);
  });
});
