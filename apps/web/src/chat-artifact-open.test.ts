import { describe, expect, test } from "bun:test";

import type { ArtifactDetail } from "./api";
import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
  artifactContentFromDetail,
  artifactContentFromDetailError,
} from "./chat-artifact-open";

describe("artifactContentFromBlob", () => {
  test("decodes a text/markdown blob through the doc renderer", () => {
    const content = artifactContentFromBlob(
      { name: "notes.md", mediaType: "text/markdown" },
      "blob_m1_1",
      btoa("# Title\nBody"),
    );
    expect(content).toEqual({
      id: "blob_m1_1",
      title: "notes.md",
      rendererKind: "doc",
      content: "# Title\nBody",
    });
  });

  test("decodes a text/csv blob through the sheet renderer", () => {
    const content = artifactContentFromBlob(
      { name: "q1.csv", mediaType: "text/csv" },
      "blob_m1_2",
      btoa("a,b\n1,2"),
    );
    expect(content.rendererKind).toBe("sheet");
    expect(content.content).toBe("a,b\n1,2");
  });

  test("a binary MIME type is not decoded — renders unsupported with a reason", () => {
    const content = artifactContentFromBlob(
      { name: "logo.png", mediaType: "image/png" },
      "blob_m1_3",
      btoa("not real png bytes"),
    );
    expect(content.rendererKind).toBe("unsupported");
    expect(content.content).toBe("");
    expect(content.unavailableReason).toContain("image/png");
  });
});

describe("artifactContentFromBlobError", () => {
  test("renders unsupported with the failure reason", () => {
    const content = artifactContentFromBlobError(
      { name: "report.pdf" },
      "blob_m1_4",
      "The server answered 404.",
    );
    expect(content.rendererKind).toBe("unsupported");
    expect(content.title).toBe("report.pdf");
    expect(content.unavailableReason).toContain("The server answered 404.");
  });
});

function artifactDetail(overrides: Partial<ArtifactDetail>): ArtifactDetail {
  return {
    id: "art_1",
    kind: "document",
    title: "Q3 report",
    source: { origin: "workflow", runId: "run_1" },
    version: 1,
    ownerPrincipalId: null,
    ownerName: null,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    content: "# Q3\nGrowth is up.",
    ...overrides,
  };
}

describe("artifactContentFromDetail", () => {
  test("resolves the renderer kind the same way Library detail does", () => {
    const content = artifactContentFromDetail(artifactDetail({}));
    expect(content).toEqual({
      id: "art_1",
      title: "Q3 report",
      rendererKind: "doc",
      content: "# Q3\nGrowth is up.",
      canEdit: true,
    });
  });

  test("never falls back to blob bytes — it reads the artifact's own content", () => {
    const content = artifactContentFromDetail(
      artifactDetail({ kind: "csv-export", title: "Signups", content: "a,b" }),
    );
    expect(content.rendererKind).toBe("sheet");
    expect(content.content).toBe("a,b");
  });

  test("a non-text kind is never marked editable — only 'doc' co-edits", () => {
    const content = artifactContentFromDetail(
      artifactDetail({ kind: "csv-export", title: "Signups", content: "a,b" }),
    );
    expect(content.canEdit).toBe(false);
  });
});

describe("artifactContentFromDetailError", () => {
  test("renders unsupported with the failure reason", () => {
    const content = artifactContentFromDetailError(
      { name: "Q3 report" },
      "art_1",
      "The hub answered 404.",
    );
    expect(content.rendererKind).toBe("unsupported");
    expect(content.title).toBe("Q3 report");
    expect(content.unavailableReason).toContain("The hub answered 404.");
  });
});
