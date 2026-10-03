// Workflows: an ops table of deployed workflow definitions, including
// paused (`stopped`) ones. Run-now is the only write.
import { EmptyState, RichEmptyState, RunNowButton } from "@corbits/react-ui";
import { cronSentence } from "@corbits/workflows/client";
import { useState, type ReactNode } from "react";
import { Clock } from "@/lib/icons";

import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { routineDetailPath } from "../global-routines";
import { Link } from "../navigation";
import { benchLink, useFromBench } from "../shell/page-crumbs";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import { ListCard, ListFilter } from "./library-list";
import {
  PauseResumeButton,
  RoutinePill,
  formatWhen,
  routineState,
  useRoutineRuns,
} from "./routine-ui";

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
      className="lib-row"
      data-ctx-routine={row.definition.definitionId}
      data-ctx-routine-name={row.definition.name}
    >
      <Link
        to={benchLink(routineDetailPath(row.definition.definitionId), fromId)}
        className="lib-cell lib-name lib-name--mono"
      >
        {row.definition.name}
      </Link>
      <span className="lib-cell">{scheduleSentence(row.definition.schedule)}</span>
      <span className="lib-cell">{row.tenantName === "" ? "This workbench" : row.tenantName}</span>
      <span className="lib-cell">
        {runs.kind === "ready" ? formatWhen(lastRun?.createdAt) : "…"}
      </span>
      <span className="lib-cell">
        <RoutinePill tone={state.tone}>{state.label}</RoutinePill>
      </span>
      <div className="lib-cell lib-cell--end">
        <PauseResumeButton row={row} />
        <RunNowButton variant="outline" size="sm" onRun={() => onRunNow(row)} />
      </div>
    </li>
  );
}

function WorkflowsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <PageLayout
      title="Workflows"
      subtitle="Deployed workflows, when they run, and how the last run went."
    >
      {children}
    </PageLayout>
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
  const filter = <ListFilter label="Filter workflows" value={query} onChange={setQuery} />;
  if (rows.length === 0) {
    return (
      <WorkflowsLayout>
        {filter}
        <RichEmptyState
          icon={<Clock />}
          title="No workflows yet"
          description="A deployed workflow shows up here. Run it now from its row."
        />
      </WorkflowsLayout>
    );
  }
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    `${row.definition.name} ${scheduleSentence(row.definition.schedule)}`
      .toLowerCase()
      .includes(needle),
  );
  return (
    <WorkflowsLayout>
      {filter}
      <ListCard
        label="Workflows"
        columns="minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.8fr) auto auto"
        heads={["Workflow", "Schedule", "Delivers to", "Last run", "Status", ""]}
      >
        {shown.map((row) => (
          <RoutineListRow
            key={row.definition.definitionId}
            row={row}
            fromId={fromId}
            onRunNow={onRunNow}
          />
        ))}
      </ListCard>
    </WorkflowsLayout>
  );
}

export function RoutinesRoute() {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];

  return (
    <div className="page-frame">
      <StageTopBar title="Workflows" />
      <div className="stage-content page-scroll-column">
        {routinesQuery.kind === "loading" ? (
          <WorkflowsLayout>
            <EmptyState icon={<Clock />} title="Loading workflows…" />
          </WorkflowsLayout>
        ) : routinesQuery.kind === "error" ? (
          <WorkflowsLayout>
            <RichEmptyState
              icon={<Clock />}
              title="Couldn't load workflows"
              description={routinesQuery.message}
            />
          </WorkflowsLayout>
        ) : (
          <GlobalRoutinesList rows={rows} onRunNow={(row) => actions.runNow(row)} />
        )}
      </div>
    </div>
  );
}
