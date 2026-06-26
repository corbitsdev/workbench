import { describe, expect, it } from "bun:test";
import type { ArtifactWithSession } from "@workbench/shared";
import { toGalleryArtifact, visualForKind } from "./artifact-visuals";

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
});

describe("toGalleryArtifact", () => {
  const base: ArtifactWithSession = {
    id: "a-1",
    sessionId: "wf-1",
    parentId: null,
    painPointId: "p-1",
    kind: "email",
    title: "Title",
    content: "body",
    status: "approved",
    version: 1,
    ownerPrincipalId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionName: "Acme Corp",
    sessionStatus: "done",
    ownerName: null,
  };

  it("uses session name as the from label", () => {
    expect(toGalleryArtifact(base).from).toBe("Acme Corp");
  });

  it("falls back to a placeholder when session name is null", () => {
    expect(toGalleryArtifact({ ...base, sessionName: null }).from).toBe(
      "Untitled job",
    );
  });

  it("labels a session-less artifact with the workflow-supplied jobLabel, not 'Untitled job' (CL-2411)", () => {
    const research = {
      ...base,
      sessionName: null,
      kind: "research",
      source: { citations: [], jobLabel: "Last 30 days research" },
    } as ArtifactWithSession;
    expect(toGalleryArtifact(research).from).toBe("Last 30 days research");
  });

  it("falls back to 'Untitled job' when a session-less artifact has no jobLabel (CL-2411)", () => {
    const noLabel = {
      ...base,
      sessionName: null,
      source: { citations: [] },
    } as ArtifactWithSession;
    expect(toGalleryArtifact(noLabel).from).toBe("Untitled job");
  });

  it("returns empty time string for an unparseable timestamp (NaN guard)", () => {
    expect(toGalleryArtifact({ ...base, updatedAt: "not-a-date" }).time).toBe(
      "",
    );
  });
});
