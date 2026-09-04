// Routines: an ops table of authored workflow definitions that carry a
// ScheduleTrigger, including paused (`stopped`) ones. Pause/resume and
// run-now are the only writes; schedules are authored on the definition.
import {
  EmptyState,
  RichEmptyState,
  RunNowButton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { Clock } from "@corbits/icons";
import { cronSentence } from "@corbits/workflows/client";

import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { routineDetailPath } from "../global-routines";
import { Link } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";

export type { GlobalRoutineRow } from "../global-routines";

export function scheduleSentence(cron: string): string {
  return cronSentence(cron) ?? cron;
}

export function GlobalRoutinesList({
  rows,
  onToggleEnabled,
  onRunNow,
}: {
  readonly rows: readonly GlobalRoutineRow[];
  readonly onToggleEnabled: (row: GlobalRoutineRow, enabled: boolean) => void;
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="No scheduled workflows yet"
        description="A workflow with a schedule shows up here. Pause, resume, or run it now."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Routine</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>On</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const enabled = row.definition.status === "deployed";
          return (
            <TableRow
              key={row.definition.definitionId}
              data-ctx-routine={row.definition.definitionId}
              data-ctx-routine-name={row.definition.name}
            >
              <TableCell>
                <span className="flex flex-col">
                  <Link
                    to={routineDetailPath(row.definition.definitionId)}
                    className="text-sm font-medium"
                  >
                    {row.definition.name}
                  </Link>
                  <span className="text-xs text-[var(--ui-fg-muted)]">
                    {row.tenantName}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm">
                  {scheduleSentence(row.definition.cron)}
                </span>
              </TableCell>
              <TableCell>
                <Switch
                  checked={enabled}
                  label={`${enabled ? "On" : "Off"} ${row.definition.name}`}
                  onCheckedChange={(next) => onToggleEnabled(row, next)}
                />
              </TableCell>
              <TableCell>
                <RunNowButton
                  variant="outline"
                  size="sm"
                  onRun={() => onRunNow(row)}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function RoutinesRoute() {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Routines" }]}
        subtitle="Scheduled workflows. Pause, resume, or run now."
      />
      <div className="stage-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        {routinesQuery.kind === "loading" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon={<Clock />} title="Loading routines…" />
          </div>
        ) : routinesQuery.kind === "error" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <RichEmptyState
              icon={<Clock />}
              title="Couldn't load routines"
              description={routinesQuery.message}
            />
          </div>
        ) : (
          <GlobalRoutinesList
            rows={rows}
            onToggleEnabled={(row, enabled) => {
              void actions.setEnabled(row, enabled);
            }}
            onRunNow={(row) => actions.runNow(row)}
          />
        )}
      </div>
    </div>
  );
}
