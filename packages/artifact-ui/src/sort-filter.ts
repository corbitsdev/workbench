import type { ArtifactSummary } from "./types";

export type ArtifactSort = "newest" | "oldest";

/** A new array, ordered by `createdAt`. Never mutates its input — callers
 * hold the unsorted list in state and re-derive this on every render. */
export function sortArtifacts(
  artifacts: readonly ArtifactSummary[],
  sort: ArtifactSort,
): ArtifactSummary[] {
  const direction = sort === "newest" ? -1 : 1;
  return [...artifacts].sort(
    (a, b) => direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt)),
  );
}

/** Case-insensitive substring match against title and kind. An empty query
 * keeps every artifact; a query that matches nothing empties the result
 * rather than silently falling back to the full list. */
export function filterArtifacts(
  artifacts: readonly ArtifactSummary[],
  query: string,
): ArtifactSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...artifacts];
  return artifacts.filter(
    (artifact) =>
      artifact.title.toLowerCase().includes(needle) ||
      artifact.kind.toLowerCase().includes(needle),
  );
}
