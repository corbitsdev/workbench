// Routines: one global list, every automation across every workbench the
// signed-in account is a member of (CL-6362). Per-workbench routines
// chrome (the header's Routines button, the `/run` composer command, and
// the canvas pane's list/runs views) is gone — this page is the only
// place to browse routines now; a routine's own workbench still shows it
// "where it was made" via in-room notices and run-now approval cards,
// which this page never touches.
//
// The list is an ops table, not a browse list (CL-6418): a routine is a
// workflow on a schedule, so the columns are the questions an operator
// actually arrives with — when does it run next, is it healthy, when did
// it last run and how did that go. Row detail is a real page
// (`/routines/<slug>`, `routine-detail-page.tsx`), never an inline
// expansion: run history, the target workflow, and the schedule editor
// all outgrew a row long ago.
//
// Every schedule reads as a sentence (`routineScheduleSentence`), never a
// cron expression — DESIGN.md, Copy.
import {
  Badge,
  Button,
  EmptyState,
  formatRelativeTime,
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
import type { BadgeTone } from "@corbits/react-ui";
import { Clock, PlayCircle, Plus } from "@corbits/icons";
import type { KeyboardEvent } from "react";
import {
  routineHealth,
  routineScheduleSentence,
  runStatusLabel,
  triggeredByLabel,
} from "@corbits/routines/client";
import type { RoutineHealth } from "@corbits/routines/client";

import { useBench } from "../bench-context";
import {
  routineDetailPath,
  useGlobalRoutines,
  useRoutineActions,
} from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { Link } from "../navigation";
import { workbenchPath } from "../workbench-path";
import { ROUTINE_HEALTH_TONE } from "../routine-health-tone";
import { useOpenRoutineInCanvas } from "../shell/canvas-availability";
import { StageTopBar } from "../shell/stage-top-bar";
import type { RoutineRun } from "../routines-api";

export type { GlobalRoutineRow } from "../global-routines";

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  running: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};

/**
 * Recent-run rows deep-link to the workbench the routine delivers to — a
 * routine has one `deliveryWorkbenchId`, not a per-run one, so every row
 * in a given table shares the same destination. Rows render as plain data
 * when there is nowhere to deep-link (`deliveryWorkbenchId` absent or no
 * `onOpenWorkbench` handler wired). Exported: the canvas routine editor
 * panel (`shell/routine-panel.tsx`) reuses this exact rendering for its
 * own "Recent runs" section — one run table, never two drifting ones.
 */
export function RunsTable({
  runs,
  now,
  emptyTitle,
  emptyDescription,
  deliveryWorkbenchId = null,
  onOpenWorkbench,
}: {
  readonly runs: readonly RoutineRun[];
  readonly now: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly deliveryWorkbenchId?: string | null;
  readonly onOpenWorkbench?: (workbenchId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clock />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  const workbenchId =
    deliveryWorkbenchId !== null && onOpenWorkbench !== undefined
      ? deliveryWorkbenchId
      : null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Triggered by</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const rowProps =
            workbenchId !== null
              ? {
                  role: "link" as const,
                  tabIndex: 0,
                  className: "routine-run-row-linked",
                  onClick: () => onOpenWorkbench?.(workbenchId),
                  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpenWorkbench?.(workbenchId);
                  },
                }
              : {};
          return (
            <TableRow key={run.runId} {...rowProps}>
              <TableCell>
                <TriggeredByCell run={run} />
              </TableCell>
              <TableCell>
                <RunStatusCell run={run} />
              </TableCell>
              <TableCell>{formatRelativeTime(run.createdAt, now)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** What started a fire, plus the launch failure's own message when the
 * fire never produced a run at all. Shared by the roster's run table and
 * the detail page's history table. Words, not the `triggered_by` column's
 * enum (DESIGN.md, Copy). */
export function TriggeredByCell({ run }: { readonly run: RoutineRun }) {
  const hasError = run.error !== undefined && run.error !== null;
  return (
    <>
      <Badge tone={hasError ? "danger" : "neutral"}>
        {triggeredByLabel(run.triggeredBy)}
      </Badge>
      {hasError ? (
        <p className="mt-1 max-w-xs text-xs text-[var(--ui-fg-muted)]">
          {run.error}
        </p>
      ) : null}
    </>
  );
}

/** A fire's settled run status in words, or a dash when the platform has
 * no run to report (a launch that never got that far). */
export function RunStatusCell({ run }: { readonly run: RoutineRun }) {
  const status = run.run?.status;
  if (typeof status !== "string") {
    return <span className="text-[var(--ui-fg-muted)]">—</span>;
  }
  return (
    <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"}>
      {runStatusLabel(status)}
    </Badge>
  );
}

/** A routine's health, from the telemetry the scheduler already records —
 * the same reading the detail page's health rail shows, never a second
 * opinion. */
export function routineRowHealth(row: GlobalRoutineRow): RoutineHealth {
  return routineHealth(row.routine, row.runs);
}

/** "At 09:00, Monday through Friday (UTC)" — the schedule as a sentence,
 * for every routine shape including a raw cron expression. */
export function scheduleSentence(row: GlobalRoutineRow): string {
  return routineScheduleSentence(row.routine.trigger);
}

/**
 * When this routine fires next, read off the scheduler's own `nextFireAt`
 * clock rather than re-derived in the browser — a routine that is off,
 * dead-lettered, manual, or webhook-driven honestly has no next run, and
 * says so. An absent field reads the same as `null`: an un-upgraded hub
 * has told us nothing, which is not a licence to guess (see the wire
 * schema's own note).
 *
 * A due time in the past is not "2h ago" — the fire has not happened, the
 * scheduler is behind, and the word for that is overdue.
 */
export function nextRunLabel(row: GlobalRoutineRow, now: number): string {
  if (!row.routine.enabled) return "Paused";
  const nextFireAt = row.routine.nextFireAt ?? null;
  if (nextFireAt === null) return "Not scheduled";
  const due = Date.parse(nextFireAt);
  if (Number.isNaN(due)) return "Not scheduled";
  if (due <= now) return "Overdue";
  return formatRelativeTime(nextFireAt, now);
}

/** The newest fire on record — the one definition of "last run", shared
 * with the detail page's health rail through `routineHealth`. */
export function latestFire(row: GlobalRoutineRow): RoutineRun | undefined {
  return row.runs[0];
}

function HealthCell({ health }: { readonly health: RoutineHealth }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={ROUTINE_HEALTH_TONE[health.state]}>{health.label}</Badge>
      <span className="text-xs text-[var(--ui-fg-muted)]">
        {health.caption}
      </span>
    </div>
  );
}

export function GlobalRoutinesList({
  rows,
  now,
  onToggleEnabled,
  onRunNow,
  onOpenWorkbench,
}: {
  readonly rows: readonly GlobalRoutineRow[];
  readonly now: number;
  readonly onToggleEnabled: (row: GlobalRoutineRow, enabled: boolean) => void;
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
  readonly onOpenWorkbench: (workbenchId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="No routines yet"
        description="Create one from a workflow or a prompt, in any workbench."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Routine</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead className="text-right">Next run</TableHead>
          <TableHead>Health</TableHead>
          <TableHead>Last run</TableHead>
          <TableHead className="hidden lg:table-cell">Delivers to</TableHead>
          <TableHead>On</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const health = routineRowHealth(row);
          const lastRun = latestFire(row);
          return (
            <TableRow key={row.routine.id}>
              <TableCell>
                <span className="flex flex-col">
                  <Link
                    to={routineDetailPath(row.routine.id)}
                    className="text-sm font-medium"
                  >
                    {row.routine.name}
                  </Link>
                  <span className="text-xs text-[var(--ui-fg-muted)]">
                    {row.tenantName}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm">{scheduleSentence(row)}</span>
              </TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">
                {nextRunLabel(row, now)}
              </TableCell>
              <TableCell>
                <HealthCell health={health} />
              </TableCell>
              <TableCell>
                {lastRun === undefined ? (
                  <span className="text-sm text-[var(--ui-fg-muted)]">
                    Never
                  </span>
                ) : (
                  <span className="flex flex-col gap-1">
                    <span className="text-sm">
                      {formatRelativeTime(lastRun.createdAt, now)}
                    </span>
                    <RunStatusCell run={lastRun} />
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {row.routine.deliveryWorkbenchId !== null &&
                row.deliveryWorkbenchName !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 font-normal"
                    onClick={() =>
                      onOpenWorkbench(row.routine.deliveryWorkbenchId as string)
                    }
                  >
                    {row.deliveryWorkbenchName}
                  </Button>
                ) : (
                  <span className="text-sm text-[var(--ui-fg-muted)]">—</span>
                )}
              </TableCell>
              <TableCell>
                <Switch
                  checked={row.routine.enabled}
                  label={`${row.routine.enabled ? "Pause" : "Resume"} ${row.routine.name}`}
                  onCheckedChange={(enabled) => onToggleEnabled(row, enabled)}
                />
              </TableCell>
              <TableCell>
                {health.state === "paused" || !row.routine.enabled ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggleEnabled(row, true)}
                  >
                    <PlayCircle /> Resume
                  </Button>
                ) : (
                  <RunNowButton
                    variant="outline"
                    size="sm"
                    onRun={() => onRunNow(row)}
                  />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function RoutinesRoute({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const openRoutine = useOpenRoutineInCanvas();
  const { selectTenant } = useBench();
  const now = Date.now();

  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Routines" }]}
        subtitle="Scheduled work. Next fire time, last result, and health at a glance — every run is a steppable trace."
        actions={
          <Button size="sm" onClick={() => openRoutine({ routineId: null })}>
            <Plus /> New routine
          </Button>
        }
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
            now={now}
            onToggleEnabled={(row, enabled) => {
              void actions.setEnabled(row, enabled);
            }}
            onRunNow={(row) => actions.runNow(row)}
            onOpenWorkbench={(workbenchId) => {
              const row = rows.find(
                (r) => r.routine.deliveryWorkbenchId === workbenchId,
              );
              if (row === undefined) return;
              selectTenant(row.tenantId);
              navigate(workbenchPath(workbenchId));
            }}
          />
        )}
      </div>
    </div>
  );
}
