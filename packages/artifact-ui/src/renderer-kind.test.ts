import { describe, expect, test } from "bun:test";

import {
  isTextDecodableMediaType,
  resolveArtifactRendererKind,
  resolveRendererKindFromMediaType,
} from "./renderer-kind";

describe("resolveArtifactRendererKind", () => {
  test("kind document renders as doc", () => {
    expect(
      resolveArtifactRendererKind({ kind: "document", title: "Brief" }),
    ).toBe("doc");
  });

  test("kind file with a doc-ish extension renders as doc", () => {
    expect(
      resolveArtifactRendererKind({ kind: "file", title: "notes.md" }),
    ).toBe("doc");
  });

  test("kind sheet or csv-export renders as sheet", () => {
    expect(resolveArtifactRendererKind({ kind: "sheet", title: "Q1" })).toBe(
      "sheet",
    );
    expect(
      resolveArtifactRendererKind({ kind: "csv-export", title: "Q1" }),
    ).toBe("sheet");
  });

  test("kind file with a spreadsheet extension renders as sheet", () => {
    expect(
      resolveArtifactRendererKind({ kind: "file", title: "budget.csv" }),
    ).toBe("sheet");
  });

  test("kind pdf, or file with .pdf extension, renders as pdf", () => {
    expect(
      resolveArtifactRendererKind({ kind: "pdf", title: "contract" }),
    ).toBe("pdf");
    expect(
      resolveArtifactRendererKind({ kind: "file", title: "contract.pdf" }),
    ).toBe("pdf");
  });

  test("routine and unrecognized kinds fall back to unsupported", () => {
    expect(
      resolveArtifactRendererKind({ kind: "routine", title: "Weekly GTM" }),
    ).toBe("unsupported");
    expect(
      resolveArtifactRendererKind({ kind: "image", title: "logo.png" }),
    ).toBe("unsupported");
  });
});

describe("resolveRendererKindFromMediaType", () => {
  test("text/markdown and text/plain render as doc", () => {
    expect(resolveRendererKindFromMediaType("text/markdown", "notes.md")).toBe(
      "doc",
    );
    expect(resolveRendererKindFromMediaType("text/plain", "notes.txt")).toBe(
      "doc",
    );
  });

  test("text/csv renders as sheet", () => {
    expect(resolveRendererKindFromMediaType("text/csv", "q1.csv")).toBe(
      "sheet",
    );
  });

  test("application/pdf renders as pdf", () => {
    expect(
      resolveRendererKindFromMediaType("application/pdf", "contract.pdf"),
    ).toBe("pdf");
  });

  test("falls back to filename extension when the MIME type is generic", () => {
    expect(
      resolveRendererKindFromMediaType("application/octet-stream", "notes.md"),
    ).toBe("doc");
  });

  test("an unrecognized MIME type and extension is unsupported", () => {
    expect(resolveRendererKindFromMediaType("image/png", "logo.png")).toBe(
      "unsupported",
    );
  });
});

describe("isTextDecodableMediaType", () => {
  test("text-ish MIME types are decodable", () => {
    expect(isTextDecodableMediaType("text/plain")).toBe(true);
    expect(isTextDecodableMediaType("text/csv")).toBe(true);
    expect(isTextDecodableMediaType("application/json")).toBe(true);
  });

  test("binary spreadsheet and PDF types are not decodable as text", () => {
    expect(isTextDecodableMediaType("application/vnd.ms-excel")).toBe(false);
    expect(isTextDecodableMediaType("application/pdf")).toBe(false);
    expect(isTextDecodableMediaType("image/png")).toBe(false);
  });
});
