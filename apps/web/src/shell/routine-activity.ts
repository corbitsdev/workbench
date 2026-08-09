// A seam for `@corbits/routines`, which is not on `main` yet: the second
// column's "Running" section depends only on `RoutineActivityItem` and
// `listRoutineActivity`, never on where the data actually comes from. Today
// it is filled from `@corbits/chat-ui`'s `listRuns` — the workflow-instance
// listing every routine run already executes as — so the section shows real,
// bench-scoped activity rather than nothing. Once `@corbits/routines`
// publishes its own richer listing, only this file's body changes.

import { listRuns, runDisplayName } from "@corbits/chat-ui";
import type { Run } from "@corbits/chat-ui";

export type RoutineActivityItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
};

function toRoutineActivityItem(run: Run): RoutineActivityItem {
  return {
    id: run.id,
    name: runDisplayName(run),
    status: run.status,
    startedAt: run.createdAt,
  };
}

export function listRoutineActivity(
  tenantId: string,
): Promise<readonly RoutineActivityItem[]> {
  return listRuns(tenantId).then((runs) => runs.map(toRoutineActivityItem));
}
