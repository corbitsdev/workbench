import { describe, expect, it } from "bun:test";
import type { ArtifactWithSession } from "@workbench/shared";
import {
  artifactProvenance,
  artifactProvenanceLabel,
  toGalleryArtifact,
  visualForKind,
} from "./artifact-visuals";

describe("visualForKind", () => {
  it("maps known kinds to their visuals", () => {
    expect(visualForKind("email").label).toBe("Email");
    expect(visualForKind("battlecard").viz).toBe("grid");
  });

  it("maps legacy linkedin kinds through the canonical linkedin-post visual", () => {
    expect(visualForKind("linkedin-daily").label).toBe("LinkedIn Post");
    expect(visualForKind("pain-points-linkedin-post").viz).toBe("lines");
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
    expect(v.viz).toBe("deck");
  });
});

describe("toGalleryArtifact", () => {
  const base: ArtifactWithSession = {
    id: "a-1",
    parentId: null,
    kind: "email",
    title: "Title",
    content: "body",
    status: "approved",
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

  it("returns empty time string for an unparseable timestamp (NaN guard)", () => {
    expect(toGalleryArtifact({ ...base, updatedAt: "not-a-date" }).time).toBe(
      "",
    );
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
