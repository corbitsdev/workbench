import { describe, expect, it } from "bun:test";
import { getAttachmentMediaCategory, getFileTypeLabel } from "./attachment-media";

describe("getAttachmentMediaCategory", () => {
  it("classifies an image MIME type", () => {
    expect(getAttachmentMediaCategory("image/png")).toBe("image");
  });

  it("classifies a non-image MIME type as a document", () => {
    expect(getAttachmentMediaCategory("application/pdf")).toBe("document");
  });
});

describe("getFileTypeLabel", () => {
  it("derives the label from the filename extension", () => {
    expect(getFileTypeLabel("report.pdf", "application/pdf")).toBe("PDF");
  });

  it("uppercases and truncates a long extension", () => {
    expect(getFileTypeLabel("data.jsonl", "application/x-ndjson")).toBe("JSON");
  });

  it("falls back to the MIME subtype when there is no extension", () => {
    expect(getFileTypeLabel("noext", "application/pdf")).toBe("PDF");
  });

  it("falls back to FILE when neither extension nor MIME subtype is usable", () => {
    expect(getFileTypeLabel("noext", "")).toBe("FILE");
  });

  it("treats a trailing dot as having no extension", () => {
    expect(getFileTypeLabel("archive.", "application/zip")).toBe("ZIP");
  });
});
