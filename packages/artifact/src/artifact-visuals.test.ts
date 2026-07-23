import { describe, expect, it } from "bun:test";
import type { ArtifactWithSession } from "@workbench/shared";
import { GalleryArtifactParseError, parseGalleryArtifact } from "./types";
import {
  artifactProvenance,
  artifactProvenanceLabel,
  explicitVisualForKind,
  KNOWN_ARTIFACT_KINDS,
  toGalleryArtifact,
  tryToGalleryArtifact,
  visualForKind,
} from "./artifact-visuals";

describe("explicitVisualForKind", () => {
  it("returns the visual for a kind with an explicit entry", () => {
    expect(explicitVisualForKind("email")?.label).toBe("Email");
  });

  it("returns undefined (not the Document fallback) for an unmapped kind", () => {
    expect(explicitVisualForKind("totally-unknown-kind")).toBeUndefined();
  });

  it("KNOWN_ARTIFACT_KINDS enumerates every kind explicitVisualForKind resolves", () => {
    expect(KNOWN_ARTIFACT_KINDS.length).toBeGreaterThan(0);
    for (const kind of KNOWN_ARTIFACT_KINDS) {
      expect(explicitVisualForKind(kind)).toBeDefined();
    }
  });
});

describe("visualForKind", () => {
  it("maps known kinds to their visuals", () => {
    expect(visualForKind("email").label).toBe("Email");
    expect(visualForKind("battlecard").fill).toBe("bg-green");
  });

  it("maps legacy linkedin kinds through the canonical linkedin-post visual", () => {
    expect(visualForKind("linkedin-daily").label).toBe("LinkedIn Post");
    expect(visualForKind("pain-points-linkedin-post").fill).toBe("bg-blue");
  });

  it("falls back to a neutral document tile for unknown kinds", () => {
    const v = visualForKind("totally-unknown-kind");
    expect(v.label).toBe("Document");
    expect(v.fill).toBe("bg-cream");
  });

  it("labels research and report kinds as Report, not Document (CL-2411)", () => {
    expect(visualForKind("research").label).toBe("Report");
    expect(visualForKind("report").label).toBe("Report");
  });

  it("labels the heartbeat's morning-brief kind as Report, not Document (CL-3503)", () => {
    const v = visualForKind("morning-brief");
    expect(v.label).toBe("Report");
    expect(v.fill).toBe("bg-charcoal");
  });

  it("labels image artifacts as images", () => {
    expect(visualForKind("image").label).toBe("Image");
  });

  it("labels an A/B comparison artifact 'Comparison', not the generic 'Document' fallback", () => {
    expect(visualForKind("ab-comparison").label).toBe("Comparison");
  });

  it("labels presentation kinds 'Presentation', not 'Document'", () => {
    expect(visualForKind("presentation").label).toBe("Presentation");
    expect(visualForKind("gamma_presentation").label).toBe("Presentation");
  });

  it("labels Granola call artifact kinds (legacy + typed, CL-3647)", () => {
    expect(visualForKind("granola-call").label).toBe("Call");
    expect(visualForKind("granola-call-pain-points").label).toBe(
      "Call Pain Points",
    );
    expect(visualForKind("granola-call-summary").label).toBe("Call Summary");
    expect(visualForKind("granola-call-brief").label).toBe("Call Brief");
  });

  it("labels a CSV export 'CSV', not 'Document'", () => {
    expect(visualForKind("csv-export").label).toBe("CSV");
  });

  it("labels a generic file artifact 'File', not 'Document'", () => {
    expect(visualForKind("file").label).toBe("File");
  });

  it("labels web/web_site kinds 'Web page'", () => {
    expect(visualForKind("web").label).toBe("Web page");
    expect(visualForKind("web_site").label).toBe("Web page");
  });
});

describe("toGalleryArtifact", () => {
  const base: ArtifactWithSession = {
    id: "a-1",
    parentId: null,
    kind: "email",
    title: "Title",
    content: "body",
    version: 1,
    ownerPrincipalId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { origin: "workflow" },
    sessionId: null,
    sessionName: "Acme Corp",
    sessionStatus: "done",
    ownerName: null,
  };

  it("uses session name as the from label", () => {
    expect(toGalleryArtifact(base).from).toBe("Acme Corp");
  });

  it("preserves app-provided thumbnail metadata", () => {
    const gallery = toGalleryArtifact(base, {
      thumbnailUrl: "https://example.test/image.png",
      thumbnailAlt: "Uploaded image",
    });

    expect(gallery.thumbnailUrl).toBe("https://example.test/image.png");
    expect(gallery.thumbnailAlt).toBe("Uploaded image");
  });

  it("omits `from` rather than inventing filler text when session name is null", () => {
    expect(
      toGalleryArtifact({ ...base, sessionName: null }).from,
    ).toBeUndefined();
  });

  it("labels a session-less artifact with the workflow-supplied jobLabel, not 'Untitled job' (CL-2411)", () => {
    const research = {
      ...base,
      sessionId: null,
      sessionName: null,
      kind: "research",
      source: {
        origin: "workflow",
        citations: [],
        jobLabel: "Last 30 days research",
      },
    } as ArtifactWithSession;
    expect(toGalleryArtifact(research).from).toBe("Last 30 days research");
  });

  it("omits `from` when a session-less artifact has no jobLabel (CL-2411, CL-3632)", () => {
    const noLabel = {
      ...base,
      sessionId: null,
      sessionName: null,
      source: { origin: "workflow", citations: [] },
    } as ArtifactWithSession;
    expect(toGalleryArtifact(noLabel).from).toBeUndefined();
  });

  it("resolves a JSON artifact body to its summary field for the preview excerpt", () => {
    expect(
      toGalleryArtifact({
        ...base,
        content: '{"summary": "Deal closed at 40% discount"}',
      }).previewExcerpt,
    ).toBe("Deal closed at 40% discount");
  });

  it("falls back to the artifact title for JSON content with no summary field", () => {
    expect(
      toGalleryArtifact({ ...base, title: "Q3 Export", content: '{"id": 1}' })
        .previewExcerpt,
    ).toBe("Q3 Export");
  });

  it("omits previewExcerpt instead of throwing when content reduces to an empty excerpt", () => {
    const gallery = toGalleryArtifact({ ...base, content: "" });
    expect("previewExcerpt" in gallery).toBe(false);
  });

  it("omits previewExcerpt for JSON content with no summary and a whitespace-only title", () => {
    const gallery = toGalleryArtifact({
      ...base,
      title: "   ",
      content: '{"id": 1}',
    });
    expect("previewExcerpt" in gallery).toBe(false);
  });

  it("summarizes a comparison artifact as 'Winner: <label> · N variants' instead of a prose excerpt", () => {
    const comparison = {
      ...base,
      kind: "ab-comparison",
      content: JSON.stringify({
        ranking: [
          { rank: 1, label: "Claude Opus" },
          { rank: 2, label: "GPT-5" },
        ],
        variants: [
          { label: "Claude Opus", content: "..." },
          { label: "GPT-5", content: "..." },
        ],
      }),
    } as ArtifactWithSession;
    expect(toGalleryArtifact(comparison).previewExcerpt).toBe(
      "Winner: Claude Opus · 2 variants",
    );
  });

  it("falls back to the prose excerpt when comparison content fails to parse", () => {
    const corruptComparison = {
      ...base,
      kind: "ab-comparison",
      content: "not valid json",
    } as ArtifactWithSession;
    expect(toGalleryArtifact(corruptComparison).previewExcerpt).toBe(
      "not valid json",
    );
  });

  it("omits creatorInitials when no viewerPrincipalId is supplied", () => {
    const gallery = toGalleryArtifact({
      ...base,
      ownerPrincipalId: "principal-owner",
      ownerName: "Sawyer Cutler",
    });
    expect(gallery.creatorInitials).toBeUndefined();
  });

  it("omits creatorInitials on the viewer's own artifact", () => {
    const gallery = toGalleryArtifact(
      { ...base, ownerPrincipalId: "principal-1", ownerName: "Sawyer Cutler" },
      { viewerPrincipalId: "principal-1" },
    );
    expect(gallery.creatorInitials).toBeUndefined();
  });

  it("derives uppercase first+last initials for a non-own artifact's named creator", () => {
    const gallery = toGalleryArtifact(
      { ...base, ownerPrincipalId: "principal-2", ownerName: "Sawyer Cutler" },
      { viewerPrincipalId: "principal-1" },
    );
    expect(gallery.creatorInitials).toBe("SC");
  });

  it("omits creatorInitials when the owner has no name", () => {
    const gallery = toGalleryArtifact(
      { ...base, ownerPrincipalId: "principal-2", ownerName: null },
      { viewerPrincipalId: "principal-1" },
    );
    expect(gallery.creatorInitials).toBeUndefined();
  });

  it("omits creatorInitials when the artifact has no owner (unowned/system)", () => {
    const gallery = toGalleryArtifact(
      { ...base, ownerPrincipalId: null, ownerName: null },
      { viewerPrincipalId: "principal-1" },
    );
    expect(gallery.creatorInitials).toBeUndefined();
  });

  it("returns empty time string for an unparseable timestamp (NaN guard)", () => {
    expect(toGalleryArtifact({ ...base, updatedAt: "not-a-date" }).time).toBe(
      "",
    );
  });
  it("maps a valid artifact through tryToGalleryArtifact", () => {
    expect(tryToGalleryArtifact(base)?.id).toBe("a-1");
  });

  it("throws the typed GalleryArtifactParseError on schema failure", () => {
    expect(() => parseGalleryArtifact({})).toThrow(GalleryArtifactParseError);
  });

  it("returns undefined from tryToGalleryArtifact for an artifact that fails the gallery schema", () => {
    const corrupt = {
      ...base,
      id: 123,
    } as unknown as ArtifactWithSession;
    expect(tryToGalleryArtifact(corrupt)).toBeUndefined();
  });

  it("surfaces the source origin as the provenance badge", () => {
    expect(
      toGalleryArtifact({ ...base, source: { origin: "manual" } }).provenance,
    ).toBe("Manual");
  });

  it("prefers an explicit generatedBy attribution over the origin label", () => {
    expect(
      toGalleryArtifact({
        ...base,
        source: { origin: "workflow", generatedBy: "Last 30 Days" },
      }).provenance,
    ).toBe("Last 30 Days");
  });

  it("tags free-text attribution so it is not uppercased", () => {
    expect(
      toGalleryArtifact({
        ...base,
        source: { origin: "workflow", generatedBy: "Last 30 Days" },
      }).provenanceTone,
    ).toBe("free");
  });

  it("tags a coarse origin word as uppercasable", () => {
    expect(
      toGalleryArtifact({ ...base, source: { origin: "manual" } })
        .provenanceTone,
    ).toBe("origin");
  });

  it("tags legacy/unknown provenance as a muted unknown state", () => {
    expect(
      toGalleryArtifact({ ...base, source: { origin: "unknown" } })
        .provenanceTone,
    ).toBe("unknown");
    expect(
      toGalleryArtifact({
        ...base,
        source: {} as ArtifactWithSession["source"],
      }).provenanceTone,
    ).toBe("unknown");
  });
});

describe("artifactProvenance", () => {
  it("returns free tone for an explicit generatedBy string", () => {
    expect(
      artifactProvenance({ origin: "workflow", generatedBy: "Last 30 Days" }),
    ).toEqual({ label: "Last 30 Days", tone: "free" });
  });

  it("returns origin tone for a coarse origin word", () => {
    expect(artifactProvenance({ origin: "agent" })).toEqual({
      label: "Agent",
      tone: "origin",
    });
  });

  it("returns unknown tone for a legacy/blank or unknown-origin source", () => {
    expect(artifactProvenance({ origin: "unknown" })).toEqual({
      label: "Unknown source",
      tone: "unknown",
    });
    expect(artifactProvenance({} as ArtifactWithSession["source"])).toEqual({
      label: "Unknown source",
      tone: "unknown",
    });
  });
});

describe("artifactProvenanceLabel", () => {
  it("falls back to an unknown-source label for a legacy/blank source", () => {
    expect(artifactProvenanceLabel({} as ArtifactWithSession["source"])).toBe(
      "Unknown source",
    );
  });

  it("maps each known origin to a human label", () => {
    expect(artifactProvenanceLabel({ origin: "workflow" })).toBe("Workflow");
    expect(artifactProvenanceLabel({ origin: "agent" })).toBe("Agent");
    expect(artifactProvenanceLabel({ origin: "imported" })).toBe("Imported");
  });
});
