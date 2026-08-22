// The second column's "Running" section and Mission Control's active-run
// count (CL-6595) both depend only on `RoutineActivityItem` and
// `listRoutineActivity`, never on where the data actually comes from.
// Filled from `./agents-api.ts`'s `listRoutineRunFires` — the `feed=fires`
// listing, the one top-level-runs view that keeps a routine's fire despite
// it being a folded run (see that function's own comment). The plain
// `listTopLevelRuns` feed looks tempting here but is wrong: its
// `notExists(folded_run)` filter drops every routine fire by construction,
// so a routine genuinely running would never show up in this band or count
// toward Mission Control's "Active runs" — exactly CL-6595's desync
// between the Routines page's own "Running now" pill and Mission Control's
// "0 / nothing running".
import { listRoutineRunFires } from "../agents-api";
import type { RunFire } from "../agents-api";

export type RoutineActivityItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
};

function toRoutineActivityItem(run: RunFire): RoutineActivityItem {
  return {
    id: run.id,
    name: run.routineName ?? run.definitionName,
    status: run.status,
    startedAt: run.createdAt,
  };
}

export function listRoutineActivity(
  tenantId: string,
): Promise<readonly RoutineActivityItem[]> {
  return listRoutineRunFires(tenantId).then((runs) =>
    runs.filter((run) => run.routineId !== null).map(toRoutineActivityItem),
  );
}
