// Workflows: an ops table of deployed workflow definitions, including
// paused (`stopped`) ones. Pause/resume and run-now are the only writes.
import { EmptyState, RichEmptyState, RunNowButton } from "@corbits/react-ui";
import { cronSentence } from "@corbits/workflows/client";
import { useState } from "react";
import { Clock } from "@/lib/icons";

import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { routineDetailPath } from "../global-routines";
import { Link } from "../navigation";
import { benchLink, useFromBench } from "../shell/page-crumbs";
import { StageTopBar } from "../shell/stage-top-bar";
import { RoutinePill, formatWhen, routineState, useRoutineRuns } from "./routine-ui";

export type { GlobalRoutineRow } from "../global-routines";

/** A schedule's human sentence, the raw expression when it can't be
 * described, or "Not scheduled" when the deployment carries no cron row. */
export function scheduleSentence(schedule: string | null): string {
  if (schedule === null) return "Not scheduled";
  return cronSentence(schedule) ?? schedule;
}

function RoutineListRow({
  row,
  fromId,
  onRunNow,
}: {
  readonly row: GlobalRoutineRow;
  readonly fromId: string | null;
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
}) {
  const runs = useRoutineRuns(row.tenantId, row.definition.definitionId, 1);
  const lastRun = runs.kind === "ready" ? runs.data.data[0] : undefined;
  const state = routineState(row, lastRun);
  return (
    <li
      className="routine-row"
      data-ctx-routine={row.definition.definitionId}
      data-ctx-routine-name={row.definition.name}
    >
      <Link
        to={benchLink(routineDetailPath(row.definition.definitionId), fromId)}
        className="routine-name"
      >
        {row.definition.name}
      </Link>
      <span className="routine-meta">{scheduleSentence(row.definition.schedule)}</span>
      <span className="routine-meta">
        {runs.kind === "ready" ? formatWhen(lastRun?.createdAt) : "…"}
      </span>
      <RoutinePill tone={state.tone}>{state.label}</RoutinePill>
      <RunNowButton variant="outline" size="sm" onRun={() => onRunNow(row)} />
    </li>
  );
}

export function GlobalRoutinesList({
  rows,
  onRunNow,
}: {
  readonly rows: readonly GlobalRoutineRow[];
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const fromId = useFromBench();
  if (rows.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="No workflows yet"
        description="A deployed workflow shows up here. Run it now from its row."
      />
    );
  }
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    `${row.definition.name} ${scheduleSentence(row.definition.schedule)}`
      .toLowerCase()
      .includes(needle),
  );
  return (
    <div className="routines-page">
      <h1>Workflows</h1>
      <p className="routines-lede">Deployed workflows, when they run, and how the last run went.</p>
      <input
        className="routines-filter"
        placeholder="Filter workflows"
        aria-label="Filter workflows"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="routine-rows">
        {shown.map((row) => (
          <RoutineListRow
            key={row.definition.definitionId}
            row={row}
            fromId={fromId}
            onRunNow={onRunNow}
          />
        ))}
      </ul>
    </div>
  );
}

export function RoutinesRoute() {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: "Workflows" }]} />
      <div className="stage-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        {routinesQuery.kind === "loading" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon={<Clock />} title="Loading workflows…" />
          </div>
        ) : routinesQuery.kind === "error" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <RichEmptyState
              icon={<Clock />}
              title="Couldn't load workflows"
              description={routinesQuery.message}
            />
          </div>
        ) : (
          <GlobalRoutinesList rows={rows} onRunNow={(row) => actions.runNow(row)} />
        )}
      </div>
    </div>
  );
}
