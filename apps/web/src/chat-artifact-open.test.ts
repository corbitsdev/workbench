import { describe, expect, test } from "bun:test";

import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
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
      "The hub answered 404.",
    );
    expect(content.rendererKind).toBe("unsupported");
    expect(content.title).toBe("report.pdf");
    expect(content.unavailableReason).toContain("The hub answered 404.");
  });
});
