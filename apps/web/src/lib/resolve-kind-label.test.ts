import { describe, expect, it } from "bun:test";
import { resolveKindLabel } from "./resolve-kind-label";

describe("resolveKindLabel", () => {
  it("humanizes kinds", () => {
    expect(resolveKindLabel("founder-pov-post")).toBe("Founder POV Post");
    expect(resolveKindLabel("seo-enrichment")).toBe("SEO Enrichment");
  });

  it("uses the explicit override for ab-comparison", () => {
    expect(resolveKindLabel("ab-comparison")).toBe("A/B Comparison");
  });

  it("returns undefined for empty values", () => {
    expect(resolveKindLabel(null)).toBeUndefined();
    expect(resolveKindLabel(undefined)).toBeUndefined();
  });
});
