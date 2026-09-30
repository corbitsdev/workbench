// A link, not a lineage system — every other `source` shape reads as
// "nothing to show" rather than guessed at.

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

/** Where an artifact came from, for the list's From column. Null when the
 * `source` names no origin. */
export function artifactFromLabel(
  source: Record<string, unknown> | null | undefined,
): string | null {
  if (source === null || source === undefined) return null;
  if (source.origin === "workflow") return "Workflow run";
  return typeof source.origin === "string" && source.origin !== "" ? source.origin : null;
}
