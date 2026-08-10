// Deep-link targets for Insights rows. The only existing per-run surface is
// the Routines page, which owns the `/routines/:id` prefix and is the same
// target the command palette navigates to for a run — so Insights rows jump
// to the same place rather than inventing a route that does not exist yet.

export const ROUTINES_PATH_PREFIX = "/routines";

/** Canonical `/routines/:id` path a run row deep-links into. */
export function runDetailPath(runId: string): string {
  return `${ROUTINES_PATH_PREFIX}/${encodeURIComponent(runId)}`;
}

/** The deep-link target for a recent-run row — its own detail on Routines. */
export function runDeepLinkTarget(run: { readonly id: string }): string {
  return runDetailPath(run.id);
}
