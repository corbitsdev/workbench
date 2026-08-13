import { describe, expect, test } from "bun:test";

import {
  artifactMatchesLibraryKindSegment,
  libraryKindSegmentFromPath,
} from "./kind-filter";

describe("libraryKindSegmentFromPath", () => {
  test("returns empty for the bare library path", () => {
    expect(libraryKindSegmentFromPath("/library")).toBe("");
    expect(libraryKindSegmentFromPath("/library/")).toBe("");
  });

  test("returns the first segment under /library", () => {
    expect(libraryKindSegmentFromPath("/library/document")).toBe("document");
    expect(libraryKindSegmentFromPath("/library/pdf/extra")).toBe("pdf");
  });

  test("returns empty for a path outside /library", () => {
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
