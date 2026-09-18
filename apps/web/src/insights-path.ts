// Insights' own route parser — its own module (not inlined in
// insights-page.tsx) so it can be exercised directly without dragging in
// that page's bench/query-client wiring.

import { decodedOrNull } from "@corbits/url-path";

import { INSIGHTS_PATH_PREFIX, INSIGHTS_RUNS_PATH } from "./path-ids";

// A malformed percent-escape or stale/retired path falls through to the
// plain landing default, never to a detail mode with a `null` id that
// would render a permanently-empty dashboard.
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
