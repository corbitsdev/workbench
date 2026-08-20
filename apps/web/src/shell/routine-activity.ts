// A seam for `@corbits/routines`, which is not on `main` yet: the second
// column's "Running" section depends only on `RoutineActivityItem` and
// `listRoutineActivity`, never on where the data actually comes from. Today
// it is filled from `./agents-api.ts`'s `listTopLevelRuns` — the tenant's
// genuine top-level deployment runs, folded runs already excluded
// server-side (see `@corbits/folded-runs`'s `scope-routes.ts`) — so the
// section shows real, bench-scoped activity rather than nothing. Once
// `@corbits/routines` publishes its own richer listing, only this file's
// body changes.

import { listTopLevelRuns } from "../agents-api";
import type { AgentInstance } from "../agents-api";

export type RoutineActivityItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
};

function toRoutineActivityItem(run: AgentInstance): RoutineActivityItem {
  return {
    id: run.id,
    name: run.definitionName,
    status: run.status,
    startedAt: run.createdAt,
  };
}

export function listRoutineActivity(
  tenantId: string,
): Promise<readonly RoutineActivityItem[]> {
  return listTopLevelRuns(tenantId).then((runs) =>
    runs.map(toRoutineActivityItem),
  );
}
