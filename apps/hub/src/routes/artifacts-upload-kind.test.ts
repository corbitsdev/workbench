import { describe, expect, it } from "bun:test";
import {
  effectiveUploadMimeForTest,
  uploadArtifactKindForTest,
} from "./artifacts";

function file(name: string, type: string): File {
  return new File(["content"], name, { type });
}

describe("artifact upload image kind detection", () => {
  it.each([
    ["image.png", "image/png"],
    ["image.jpg", "image/jpeg"],
    ["image.jpeg", "image/jpeg"],
    ["image.gif", "image/gif"],
    ["image.webp", "image/webp"],
  ])("treats %s uploads as image artifacts", (filename, mimeType) => {
    expect(
      uploadArtifactKindForTest(
        effectiveUploadMimeForTest(file(filename, mimeType)),
      ),
    ).toBe("image");
  });

  it("uses the extension when the browser omits an image MIME", () => {
    expect(
      uploadArtifactKindForTest(
        effectiveUploadMimeForTest(file("image.png", "")),
      ),
    ).toBe("image");
  });

  it("rejects SVG uploads to avoid a stored-XSS vector", () => {
    // SVG can carry inline <script>; it is intentionally not an accepted
    // upload, so its effective MIME resolves to empty (rejected) whether or not
    // the browser declares the type.
    expect(effectiveUploadMimeForTest(file("logo.svg", "image/svg+xml"))).toBe(
      "",
    );
    expect(effectiveUploadMimeForTest(file("logo.svg", ""))).toBe("");
  });

  it("leaves non-image uploads as files", () => {
    expect(
      uploadArtifactKindForTest(
        effectiveUploadMimeForTest(file("notes.md", "text/markdown")),
      ),
    ).toBe("file");
  });
});
