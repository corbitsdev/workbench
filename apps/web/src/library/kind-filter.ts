// Names here keep the "library" vocabulary (the internal name for the
// artifact store), but `LIBRARY_PATH` tracks the app's real mount point.

import { decodedOrNull } from "@corbits/url-path";

import { titleExtension } from "./title-extension";
import type { ArtifactSummary } from "./artifact-summary";

const LIBRARY_PATH = "/artifacts";

/** Kind nav segments in display order, excluding the implicit "all". */
export const LIBRARY_KIND_SEGMENTS = ["document", "sheet", "pdf", "routine"] as const;

export type LibraryKindSegment = (typeof LIBRARY_KIND_SEGMENTS)[number];

/** Path segment under `/artifacts` used as a kind filter; empty means All. */
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

/** Deep link to one artifact selected in Artifacts — the seam a chat
 * artifact chip's "Open in Artifacts" affordance navigates to. */
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
  return decodedOrNull(rest);
}

// Empty segment matches all; see `resolveArtifactRendererKind` for the
// same kind/extension mapping this reuses.
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
