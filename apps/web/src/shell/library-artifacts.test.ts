import { describe, expect, test } from "bun:test";

import {
  artifactUploadToast,
  copyArtifactLinksActionLabel,
  copyArtifactLinksToastLabel,
} from "./library-artifacts";

describe("copy-link labels", () => {
  test("action label is count-aware", () => {
    expect(copyArtifactLinksActionLabel(1)).toBe("Copy link");
    expect(copyArtifactLinksActionLabel(3)).toBe("Copy 3 links");
  });

  test("toast label is count-aware", () => {
    expect(copyArtifactLinksToastLabel(1)).toBe("Link copied");
    expect(copyArtifactLinksToastLabel(3)).toBe("3 links copied");
  });
});

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
