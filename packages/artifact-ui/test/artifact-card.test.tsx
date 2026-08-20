// The Library card's kind badge, tested at our wiring: it must render the
// same humanized label react-ui's own artifact surfaces use
// (artifactKindLabel), never the raw catalog kind string.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ArtifactCard } from "../src/artifact-card";
import type { ArtifactSummary } from "../src/types";

function artifact(
  overrides: Partial<ArtifactSummary> & { readonly id: string },
): ArtifactSummary {
  return {
    title: "Untitled",
    kind: "document",
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

describe("ArtifactCard", () => {
  test("humanizes a snake_case kind instead of rendering it raw", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard artifact={artifact({ id: "a1", kind: "call_notes" })} />,
    );
    expect(markup).toContain("Call notes");
    expect(markup).not.toContain(">call_notes<");
  });

  test("relies on Badge's own uppercase treatment instead of a redundant mono override", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard artifact={artifact({ id: "a2", kind: "document" })} />,
    );
    expect(markup).not.toContain("font-mono");
  });
});
