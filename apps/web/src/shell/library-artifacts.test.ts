import { describe, expect, test } from "bun:test";

import { artifactUploadToast } from "./library-artifacts";

describe("artifactUploadToast", () => {
  test("a single file is confirmed by name", () => {
    expect(artifactUploadToast(["q3-report.pdf"])).toBe(
      "Uploaded · q3-report.pdf",
    );
  });

  test("several files are confirmed by count", () => {
    expect(artifactUploadToast(["a.png", "b.png", "c.png", "d.png"])).toBe(
      "Uploaded 4 files",
    );
  });
});
