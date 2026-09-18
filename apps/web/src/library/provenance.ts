// The one cheap provenance fact Library detail is worth showing: the
// workflow run that produced an artifact, when its `source` says so
// (`@corbits/artifacts`' `normalizeSource` — `{ origin: "workflow", runId }`
// written by `packages/artifacts-hub`'s workflow finalize route). This is a
// link, not a lineage system — every other origin, or a `source` shaped any
// other way, reads as "nothing to show" rather than guessed at.

/** The workflow run id behind an artifact, or null when its `source` isn't
 * a recognized workflow origin. */
export function workflowRunIdFromSource(
  source: Record<string, unknown> | null | undefined,
): string | null {
  if (source === null || source === undefined) return null;
  if (source.origin !== "workflow") return null;
  const runId = source.runId;
  return typeof runId === "string" && runId !== "" ? runId : null;
}
