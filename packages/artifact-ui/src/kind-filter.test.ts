import { describe, expect, test } from "bun:test";

import {
  artifactMatchesLibraryKindSegment,
  libraryArtifactIdFromPath,
  libraryArtifactPath,
  libraryKindSegmentFromPath,
} from "./kind-filter";

describe("libraryKindSegmentFromPath", () => {
  test("returns empty for the bare library path", () => {
    expect(libraryKindSegmentFromPath("/files")).toBe("");
    expect(libraryKindSegmentFromPath("/files/")).toBe("");
  });

  test("returns the first segment under /files", () => {
    expect(libraryKindSegmentFromPath("/files/document")).toBe("document");
    expect(libraryKindSegmentFromPath("/files/pdf/extra")).toBe("pdf");
  });

  test("returns empty for a path outside /files", () => {
    expect(libraryKindSegmentFromPath("/routines")).toBe("");
  });
});

describe("artifactMatchesLibraryKindSegment", () => {
  test("empty segment matches everything", () => {
    expect(
      artifactMatchesLibraryKindSegment({ kind: "routine", title: "r" }, ""),
    ).toBe(true);
  });

  test("document segment matches kind document and file with doc-ish extension", () => {
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "document", title: "brief" },
        "document",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "notes.md" },
        "document",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "data.csv" },
        "document",
      ),
    ).toBe(false);
  });

  test("sheet segment matches csv-export, sheet, and spreadsheet-ish files", () => {
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "csv-export", title: "q1" },
        "sheet",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "budget.xls" },
        "sheet",
      ),
    ).toBe(true);
  });

  test("pdf segment matches kind pdf and file with .pdf extension", () => {
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "pdf", title: "contract" },
        "pdf",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "contract.pdf" },
        "pdf",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "contract.docx" },
        "pdf",
      ),
    ).toBe(false);
  });

  test("routine segment matches only kind routine", () => {
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "routine", title: "digest" },
        "routine",
      ),
    ).toBe(true);
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "file", title: "digest.md" },
        "routine",
      ),
    ).toBe(false);
  });

  test("unknown segment matches nothing", () => {
    expect(
      artifactMatchesLibraryKindSegment(
        { kind: "document", title: "brief" },
        "unknown",
      ),
    ).toBe(false);
  });
});

describe("libraryArtifactPath / libraryArtifactIdFromPath", () => {
  test("round-trips an artifact id through the deep link", () => {
    const path = libraryArtifactPath("art_1");
    expect(path).toBe("/files/a/art_1");
    expect(libraryArtifactIdFromPath(path)).toBe("art_1");
  });

  test("encodes and decodes ids with reserved characters", () => {
    const path = libraryArtifactPath("art/weird id");
    expect(libraryArtifactIdFromPath(path)).toBe("art/weird id");
  });

  test("is null for a plain kind-nav path, never mistaken for a kind segment", () => {
    expect(libraryArtifactIdFromPath("/files/document")).toBeNull();
    expect(libraryArtifactIdFromPath("/files")).toBeNull();
    expect(libraryArtifactIdFromPath("/routines")).toBeNull();
  });

  test("is null when the artifact segment is empty", () => {
    expect(libraryArtifactIdFromPath("/files/a/")).toBeNull();
  });

  test("a malformed escape reads as no selection, not a throw", () => {
    expect(() => libraryArtifactIdFromPath("/files/a/%E0%A4%A")).not.toThrow();
    expect(libraryArtifactIdFromPath("/files/a/%E0%A4%A")).toBeNull();
  });
});
