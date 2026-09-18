// The hub's own copy of the Files kind-nav mapping, kept in step with
// `apps/web/src/library/kind-filter.ts` by hand: it buckets the same
// `ArtifactListRow`s `@corbits/artifacts`' `countArtifactsBySegments`
// walks, so the per-kind counts the web app's kind nav shows match what
// the web app itself filters client-side.

import type { ArtifactListRow } from "@corbits/artifacts";

export const LIBRARY_KIND_SEGMENTS = ["document", "sheet", "pdf", "routine"] as const;

function titleExtension(title: string): string {
  const lower = title.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function artifactMatchesLibraryKindSegment(
  artifact: Pick<ArtifactListRow, "kind" | "title">,
  segment: string,
): boolean {
  const kind = artifact.kind.trim().toLowerCase();
  const ext = titleExtension(artifact.title);

  switch (segment) {
    case "document":
      if (kind === "document") return true;
      return kind === "file" && (ext === "doc" || ext === "txt" || ext === "md");
    case "sheet":
      if (kind === "csv-export" || kind === "sheet") return true;
      return kind === "file" && (ext === "xls" || ext === "csv");
    case "pdf":
      if (kind === "pdf") return true;
      return kind === "file" && ext === "pdf";
    case "routine":
      return kind === "routine";
    default:
      return false;
  }
}
