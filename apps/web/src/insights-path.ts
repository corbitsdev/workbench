// Insights' own route parser — its own module (not inlined in
// insights-page.tsx) so it can be exercised directly without dragging in
// that page's bench/query-client wiring.

import { decodedOrNull } from "@corbits/url-path";

import { INSIGHTS_PATH_PREFIX, INSIGHTS_RUNS_PATH } from "./path-ids";

/**
 * `/insights/workbench/:workbenchId` (CL-5879) is its own dedicated route — a
 * conversation's own scoped view, resolved by `InsightsWorkbenchPage`, never
 * a sub-mode of the landing. Every other path stays the cross-workbench
 * default landing: no per-mode branch needed there, since scoping happens
 * in InsightsRoute (which tenantId every query below targets), not here.
 * A stale `/insights/workbench/:tenantId` link (that route is retired,
 * hard cut) falls through to the plain landing default below rather than
 * matching anything.
 *
 * A malformed percent-escape in the id segment reads as the plain landing
 * default too, never as a detail mode with no entity to show — `mode:
 * "workbench"` (or `"run"`) with a `null` id would otherwise render that
 * mode's own scoped, permanently-empty dashboard instead of falling back
 * to the landing view any other unresolvable path already gets.
 */
export function parseInsightsPath(path: string): {
  mode: "landing" | "runs" | "run" | "workbench";
  runId: string | null;
  workbenchId: string | null;
} {
  const workbenchMatch = /^\/insights\/workbench\/([^/]+)\/?$/.exec(path);
  if (workbenchMatch !== null && workbenchMatch[1] !== undefined) {
    const workbenchId = decodedOrNull(workbenchMatch[1]);
    if (workbenchId !== null) {
      return { mode: "workbench", runId: null, workbenchId };
    }
  }
  if (path === INSIGHTS_PATH_PREFIX || path === `${INSIGHTS_PATH_PREFIX}/`) {
    return { mode: "landing", runId: null, workbenchId: null };
  }
  if (path === INSIGHTS_RUNS_PATH || path === `${INSIGHTS_RUNS_PATH}/`) {
    return { mode: "runs", runId: null, workbenchId: null };
  }
  const match = /^\/insights\/runs\/([^/]+)\/?$/.exec(path);
  if (match !== null && match[1] !== undefined) {
    const runId = decodedOrNull(match[1]);
    if (runId !== null) {
      return { mode: "run", runId, workbenchId: null };
    }
  }
  return { mode: "landing", runId: null, workbenchId: null };
}
