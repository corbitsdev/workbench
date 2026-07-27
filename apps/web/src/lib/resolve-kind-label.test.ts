import { describe, expect, it } from "bun:test";
import {
  explicitVisualForKind,
  KNOWN_ARTIFACT_KINDS,
} from "@workbench/artifact";
import { resolveKindLabel } from "./resolve-kind-label";

describe("resolveKindLabel", () => {
  it("humanizes a kind the artifact package has no explicit entry for", () => {
    expect(resolveKindLabel("seo-enrichment")).toBe("SEO enrichment");
  });

  it("defers to the artifact package's label for a kind it explicitly maps, not the generic humanizer", () => {
    // founder-pov-post is in @workbench/artifact's KIND_VISUALS as "Founder
    // POV" (the gallery card's chip) — toHumanLabel alone would instead
    // produce "Founder POV post". This kind must resolve to the SAME value
    // the card renders, or the detail header and the gallery chip disagree.
    expect(resolveKindLabel("founder-pov-post")).toBe(
      explicitVisualForKind("founder-pov-post")?.label,
    );
    expect(resolveKindLabel("founder-pov-post")).toBe("Founder POV");
  });

  it("uses the artifact package's 'Comparison' label for ab-comparison, not a locally-invented override", () => {
    expect(resolveKindLabel("ab-comparison")).toBe("Comparison");
  });

  it("returns undefined for empty values", () => {
    expect(resolveKindLabel(null)).toBeUndefined();
    expect(resolveKindLabel(undefined)).toBeUndefined();
  });

  it("produces the exact same label as the gallery card chip for every kind @workbench/artifact knows about", () => {
    for (const kind of KNOWN_ARTIFACT_KINDS) {
      expect(resolveKindLabel(kind)).toBe(explicitVisualForKind(kind)?.label);
    }
  });
});
