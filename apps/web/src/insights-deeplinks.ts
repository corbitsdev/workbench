// Deep-link targets for purpose workflow runs. Insights owns the run
// surface; routines keep their own fire-history paths separately.

export const INSIGHTS_PATH_PREFIX = "/insights";
export const INSIGHTS_RUNS_PATH = `${INSIGHTS_PATH_PREFIX}/runs`;

/** Legacy alias used by the command palette and older call sites. */
export const ROUTINES_PATH_PREFIX = INSIGHTS_RUNS_PATH;

export function runDetailPath(runId: string): string {
  return `${INSIGHTS_RUNS_PATH}/${encodeURIComponent(runId)}`;
}

export function runDeepLinkTarget(run: { readonly id: string }): string {
  return runDetailPath(run.id);
}

/** Insights scoped to one channel (CL-5879) — the target for the
 * conversation action bar's "Insights" entry point. The route resolves the
 * channel's own workbench tenant itself (see `../insights-channel-scope.ts`)
 * rather than trusting a tenant id from the caller, since the caller here
 * only ever has the channel id at hand. */
export function channelInsightsPath(channelId: string): string {
  return `${INSIGHTS_PATH_PREFIX}/channel/${encodeURIComponent(channelId)}`;
}
