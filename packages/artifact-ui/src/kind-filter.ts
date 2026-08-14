// Pure helpers for the Library kind nav (`/library`, `/library/document`, …).
// Framework-free so both the web app (rendering the nav + filtering the
// visible list) and the hub (computing honest per-kind counts server-side)
// share one mapping instead of two copies drifting apart.

import type { ArtifactSummary } from "./types";

const LIBRARY_PATH = "/library";

/** Kind nav segments in display order, excluding the implicit "all". */
export const LIBRARY_KIND_SEGMENTS = [
  "document",
  "sheet",
  "pdf",
  "routine",
] as const;

export type LibraryKindSegment = (typeof LIBRARY_KIND_SEGMENTS)[number];

/** Path segment under `/library` used as a kind filter; empty means All. */
export function libraryKindSegmentFromPath(path: string): string {
  if (path === LIBRARY_PATH || path === `${LIBRARY_PATH}/`) return "";
  if (!path.startsWith(`${LIBRARY_PATH}/`)) return "";
  const rest = path.slice(`${LIBRARY_PATH}/`.length);
  return rest.split("/")[0] ?? "";
}

/** Distinct from the kind nav segments above (`document`, `sheet`, …) — a
 * caller checks `libraryArtifactIdFromPath` before ever treating a path as
 * a kind filter, so the two never collide. */
const LIBRARY_ARTIFACT_SEGMENT = "a";

/** Deep link to one artifact selected in the Library — the seam a chat
 * artifact chip's "Open in Library" affordance navigates to (CL-6015). */
export function libraryArtifactPath(artifactId: string): string {
  return `${LIBRARY_PATH}/${LIBRARY_ARTIFACT_SEGMENT}/${encodeURIComponent(artifactId)}`;
}

/** Extracts the artifact id from a `libraryArtifactPath` deep link, or null
 * for every other Library path (including plain kind-nav segments). */
export function libraryArtifactIdFromPath(path: string): string | null {
  const prefix = `${LIBRARY_PATH}/${LIBRARY_ARTIFACT_SEGMENT}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).split("/")[0];
  if (rest === undefined || rest === "") return null;
  return decodeURIComponent(rest);
}

function titleExtension(title: string): string {
  const lower = title.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

/**
 * Whether an artifact belongs under a library kind nav segment
 * (`document` | `sheet` | `pdf` | `routine`). Empty segment matches all.
 *
 * Mapping:
 * - document → kind `document`, or kind `file` with .doc/.txt/.md title
 * - sheet → kind `csv-export` | `sheet`, or kind `file` with .xls/.csv title
 * - pdf → kind `pdf`, or kind `file` with .pdf title
 * - routine → kind `routine` only
 */
export function artifactMatchesLibraryKindSegment(
  artifact: Pick<ArtifactSummary, "kind" | "title">,
  segment: string,
): boolean {
  if (segment === "") return true;

  const kind = artifact.kind.trim().toLowerCase();
  const ext = titleExtension(artifact.title);

  switch (segment) {
    case "document":
      if (kind === "document") return true;
      return (
        kind === "file" && (ext === "doc" || ext === "txt" || ext === "md")
      );
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
