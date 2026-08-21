// Evals' own route parser (CL-6465) — its own module (not inlined in
// evals-page.tsx), same split as insights-path.ts, so it can be exercised
// directly without dragging in that page's bench/query-client wiring.
//
// An eval run id is an opaque store id (`evalrun_<uuid>`), never a slug —
// same addressing choice as routines (see path-ids.ts's ROUTINE_SEGMENT
// comment): eval runs have no slug column, so the id is the only stable
// address a link can carry.

import { decodedOrNull } from "@corbits/url-path";

import { EVALS_PATH_PREFIX } from "./path-ids";

export function parseEvalsPath(path: string): {
  mode: "list" | "run";
  runId: string | null;
} {
  if (path === EVALS_PATH_PREFIX || path === `${EVALS_PATH_PREFIX}/`) {
    return { mode: "list", runId: null };
  }
  const match = /^\/evals\/([^/]+)\/?$/.exec(path);
  if (match !== null && match[1] !== undefined) {
    const runId = decodedOrNull(match[1]);
    if (runId !== null) {
      return { mode: "run", runId };
    }
  }
  return { mode: "list", runId: null };
}
