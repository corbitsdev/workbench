/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_PREVIEW_FAMILIES,
  artifactPreviewFamily,
  labelForArtifactStatus,
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
    const out = previewExcerpt(long, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("labelForArtifactStatus", () => {
  it("labels known statuses", () => {
    expect(labelForArtifactStatus("approved")).toBe("Approved");
  });
});
