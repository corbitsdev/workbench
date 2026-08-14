// The artifact chip is clickable exactly when the file part carries a
// stable id to open — either a persisted blob (`blobId`) or a link back
// to a Library artifact (`artifactId`, CL-6000) — and inert otherwise.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ArtifactChip } from "../src/artifact-chip";
import type { Part } from "../src/api";

function filePart(overrides: Partial<Part & { kind: "file" }>): Part & {
  kind: "file";
} {
  return {
    kind: "file",
    name: "Notes",
    mediaType: "text/plain",
    ...overrides,
  } as Part & { kind: "file" };
}

describe("ArtifactChip", () => {
  test("is disabled with no blobId, data, or artifactId", () => {
    const markup = renderToStaticMarkup(
      <ArtifactChip part={filePart({ data: "aGVsbG8=" })} />,
    );
    expect(markup).toContain('disabled=""');
  });

  test("is openable when artifactId is set and onOpen is supplied", () => {
    const markup = renderToStaticMarkup(
      <ArtifactChip
        part={filePart({ artifactId: "art_1" })}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain('disabled=""');
  });

  test("is openable when blobId is set and onOpen is supplied", () => {
    const markup = renderToStaticMarkup(
      <ArtifactChip part={filePart({ blobId: "blob_1" })} onOpen={() => {}} />,
    );
    expect(markup).not.toContain('disabled=""');
  });

  test("stays disabled when artifactId is set but no onOpen is supplied", () => {
    const markup = renderToStaticMarkup(
      <ArtifactChip part={filePart({ artifactId: "art_1" })} />,
    );
    expect(markup).toContain('disabled=""');
  });

  test("renders the file name and media type", () => {
    const markup = renderToStaticMarkup(
      <ArtifactChip part={filePart({ artifactId: "art_1" })} />,
    );
    expect(markup).toContain("Notes");
    expect(markup).toContain("text/plain");
  });
});
