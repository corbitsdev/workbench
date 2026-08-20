// `/routines/<slug>` — a routine's own page (CL-6418), replacing the
// placeholder CL-6412 routed here.
//
// A routine is a workflow on a schedule: schedule + target workflow +
// health + history, and nothing else. It never shows an agent it "runs
// as" — there isn't one; the thing that runs is a workflow definition,
// and its steps are read on the platform's own run surface under
// `/insights/runs`, which this page links into rather than re-rendering.
//
// The schedule reads as a sentence first and stays editable as raw cron
// underneath (DESIGN.md, Copy): the sentence is what a person checks, the
// expression is what they change. Editing writes a `cron` trigger — the
// canonical form every preset already renders to (`cronExpressionForTrigger`)
// — so saving a preset routine's expression is a schedule change, not a
// change of trigger kind.
//
// Run-now and Pause/Resume are the routine's two lifecycle actions and
// they live in the top bar's action slot, never in the page body
// (DESIGN.md, Pages & Routing). Both reuse the routines package's
// existing mutations — `POST /routines/:id/run` and `PATCH {enabled}`,
// which also clears a dead-letter — so neither is a new write path.
import {
  Badge,
  Button,
  Input,
  PageShell,
  EmptyState,
  RunNowButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import { Clock, FlowArrow } from "@corbits/icons";
import type { Slug } from "@corbits/slug";
import { useState, type ReactNode } from "react";
import {
  isValidCronExpression,
  cronExpressionForTrigger,
  cronSentence,
  routineHealth,
  routineScheduleSentence,
  timezoneForTrigger,
} from "@corbits/routines/client";
import type { RoutineHealth } from "@corbits/routines/client";

import {
  rowsForSlug,
  useGlobalRoutines,
  useInvalidateRoutines,
} from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { runDetailPath } from "../insights-deeplinks";
import { Link } from "../navigation";
import { ROUTINES_PATH_PREFIX } from "../path-ids";
import { ROUTINE_HEALTH_TONE } from "../routine-health-tone";
import { StageTopBar } from "../shell/stage-top-bar";
import { RunStatusCell, TriggeredByCell } from "./routines-page";
import {
  listWorkflowDefinitions,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
  useTenantQuery,
} from "../routines-api";
import { tenantKeys } from "../query-client";

/** The cron expression behind a routine's schedule — `null` for the
 * trigger shapes that have no clock at all (manual, webhook, run-once),
 * which get no expression field rather than an inert one. */
function editableCronFor(row: GlobalRoutineRow): string | null {
  const { trigger } = row.routine;
  if (trigger === null) return null;
  if (trigger.kind === "webhook" || trigger.kind === "once") return null;
  return cronExpressionForTrigger(trigger);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} min`;
  return `${String(Math.round(minutes / 60))} h`;
}

function RailFact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-[var(--ui-fg-muted)]">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

/** Streak, typical duration, and the last failure — the three questions
 * "is this routine well?" actually decomposes into, all read off history
 * the scheduler already writes. */
export function RoutineHealthRail({
  health,
  row,
  now,
}: {
  readonly health: RoutineHealth;
  readonly row: GlobalRoutineRow;
  readonly now: number;
}) {
  const { nextFireAt, lastFireAt } = row.routine;
  return (
    <aside className="flex w-full flex-col gap-4 rounded-md border border-[var(--ui-border)] p-4 lg:w-80">
      <div className="flex flex-col gap-1">
        <Badge tone={ROUTINE_HEALTH_TONE[health.state]}>{health.label}</Badge>
        <span className="text-xs text-[var(--ui-fg-muted)]">
          {health.caption}
        </span>
      </div>
      <RailFact label="Clean streak">
        {health.cleanStreak === 0
          ? "No clean runs on record"
          : `${String(health.cleanStreak)} run${health.cleanStreak === 1 ? "" : "s"} without a failure`}
      </RailFact>
      <RailFact label="Typical run">
        {health.medianDurationMs === null
          ? "Not measured yet"
          : formatDuration(health.medianDurationMs)}
      </RailFact>
      <RailFact label="Next run">
        {nextFireAt === null
          ? "Not scheduled"
          : formatRelativeTime(nextFireAt, now)}
      </RailFact>
      <RailFact label="Last run">
        {lastFireAt === null ? "Never" : formatRelativeTime(lastFireAt, now)}
      </RailFact>
      <RailFact label="Last failure">
        {health.lastFailure === null ? (
          "None on record"
        ) : (
          <span className="flex flex-col">
            <span>{formatRelativeTime(health.lastFailure.at, now)}</span>
            {health.lastFailure.error === null ? null : (
              <span className="text-xs text-[var(--ui-fg-muted)]">
                {health.lastFailure.error}
              </span>
            )}
          </span>
        )}
      </RailFact>
    </aside>
  );
}

/**
 * The schedule, sentence first: the raw expression is editable behind it
 * and the sentence re-renders from whatever is typed, so a person sees
 * what their change means before they save it. An expression the
 * scheduler's own parser rejects (`isValidCronExpression`, the same check
 * the server saves against) cannot be saved at all.
 */
export function RoutineScheduleSection({
  row,
  onSave,
}: {
  readonly row: GlobalRoutineRow;
  readonly onSave: (expression: string) => Promise<void>;
}) {
  const stored = editableCronFor(row);
  const timezone = timezoneForTrigger(row.routine.trigger);
  const [draft, setDraft] = useState(stored ?? "");
  const [saving, setSaving] = useState(false);
  const valid = isValidCronExpression(draft);
  const preview = valid ? cronSentence(draft, timezone) : null;
  const changed = stored !== null && draft.trim() !== stored;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-[var(--ui-fg-muted)]">
        Schedule
      </h2>
      <p className="m-0 text-lg">
        {routineScheduleSentence(row.routine.trigger)}
      </p>
      {stored === null ? null : (
        <div className="flex flex-col gap-2">
          <label
            className="text-xs uppercase tracking-wide text-[var(--ui-fg-muted)]"
            htmlFor="routine-cron"
          >
            Cron expression
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="routine-cron"
              className="max-w-64 font-mono"
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={!valid || !changed || saving}
              onClick={() => {
                setSaving(true);
                void onSave(draft.trim()).finally(() => setSaving(false));
              }}
            >
              Save schedule
            </Button>
          </div>
          <p className="m-0 text-xs text-[var(--ui-fg-muted)]">
            {preview ?? "That isn't a schedule this can run."}
          </p>
        </div>
      )}
    </section>
  );
}

/** The workflow this routine runs, with a way through to its steps on the
 * platform's own run surface. The link points at the most recent run —
 * that is where steps are actually readable — and is simply absent until
 * there is a run to read, never a button that goes nowhere. */
export function RoutineTargetSection({
  workflowName,
  latestRunId,
}: {
  readonly workflowName: string;
  readonly latestRunId: string | null;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-[var(--ui-fg-muted)]">
        Runs this workflow
      </h2>
      <div className="flex items-center gap-3">
        <span className="text-base">{workflowName}</span>
        {latestRunId === null ? (
          <span className="text-xs text-[var(--ui-fg-muted)]">
            Its steps show up here after the first run.
          </span>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link to={runDetailPath(latestRunId)}>View steps</Link>
          </Button>
        )}
      </div>
    </section>
  );
}

/** Every fire on record, each row a door into that run's own trace. */
export function RoutineRunHistory({
  row,
  now,
}: {
  readonly row: GlobalRoutineRow;
  readonly now: number;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-[var(--ui-fg-muted)]">
        Run history
      </h2>
      {row.runs.length === 0 ? (
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">
          This routine has not run yet — on its schedule or by hand.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Triggered by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Trace</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {row.runs.map((run) => (
              <TableRow key={run.runId}>
                <TableCell>
                  <TriggeredByCell run={run} />
                </TableCell>
                <TableCell>
                  <RunStatusCell run={run} />
                </TableCell>
                <TableCell>{formatRelativeTime(run.createdAt, now)}</TableCell>
                <TableCell>
                  {run.triggeredBy === "schedule-failed" ? (
                    <span className="text-sm text-[var(--ui-fg-muted)]">
                      Never started
                    </span>
                  ) : (
                    <Link to={runDetailPath(run.runId)} className="text-sm">
                      View run
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** The whole page body, given a resolved routine — pure, so the layout is
 * testable without a fetch or a router. */
export function RoutineDetailPage({
  row,
  now,
  workflowName,
  onRunNow,
  onToggleEnabled,
  onSaveSchedule,
}: {
  readonly row: GlobalRoutineRow;
  readonly now: number;
  readonly workflowName: string;
  readonly onRunNow: () => Promise<void>;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onSaveSchedule: (expression: string) => Promise<void>;
}) {
  const health = routineHealth(row.routine, row.runs);
  const latestRunId =
    row.runs.find((run) => run.triggeredBy !== "schedule-failed")?.runId ??
    null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Routines", href: ROUTINES_PATH_PREFIX },
          { label: row.routine.name },
        ]}
        subtitle={row.tenantName}
        actions={
          <>
            <RunNowButton variant="outline" size="sm" onRun={onRunNow} />
            <Button
              type="button"
              size="sm"
              onClick={() => onToggleEnabled(!row.routine.enabled)}
            >
              {row.routine.enabled ? "Pause" : "Resume"}
            </Button>
          </>
        }
      />
      <PageShell width="full" className="page-fill">
        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-8">
            {/* Keyed on the saved expression: once a save lands, the
                editor's draft is stale by definition, so it remounts
                against the schedule that is now real. */}
            <RoutineScheduleSection
              key={editableCronFor(row) ?? "no-schedule"}
              row={row}
              onSave={onSaveSchedule}
            />
            <RoutineTargetSection
              workflowName={workflowName}
              latestRunId={latestRunId}
            />
            <RoutineRunHistory row={row} now={now} />
          </div>
          <RoutineHealthRail health={health} row={row} now={now} />
        </div>
      </PageShell>
    </div>
  );
}

function NotFound({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Routines", href: ROUTINES_PATH_PREFIX },
          { label: title },
        ]}
      />
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<FlowArrow />}
          title={title}
          description={description}
          action={
            <Button asChild variant="outline">
              <Link to={ROUTINES_PATH_PREFIX}>Back to Routines</Link>
            </Button>
          }
        />
      </PageShell>
    </div>
  );
}

/** The workflow's own display name for `definitionId`. Falls back to the
 * id only while the catalog is still loading or when the definition is no
 * longer listed — a routine pointing at a retired workflow still has to
 * render. */
function useWorkflowName(row: GlobalRoutineRow | undefined): string {
  const tenantId = row?.tenantId ?? "";
  const definitions = useTenantQuery(
    [...tenantKeys.routines(tenantId), "definitions"],
    tenantId !== "",
    () => listWorkflowDefinitions(tenantId),
  );
  if (definitions.kind !== "ready" || row === undefined) {
    return row?.routine.definitionId ?? "";
  }
  const match = definitions.data.find(
    (definition) => definition.id === row.routine.definitionId,
  );
  return match?.name ?? row.routine.definitionId;
}

export function RoutineDetailRoute({ slug }: { readonly slug: Slug }) {
  const routinesQuery = useGlobalRoutines();
  const invalidate = useInvalidateRoutines();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const matches = rowsForSlug(rows, slug);
  const row = matches.length === 1 ? matches[0] : undefined;
  const workflowName = useWorkflowName(row);
  const now = Date.now();

  if (routinesQuery.kind === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={[
            { label: "Routines", href: ROUTINES_PATH_PREFIX },
            { label: slug },
          ]}
        />
        <PageShell width="full" className="page-fill">
          <EmptyState icon={<Clock />} title="Loading routine…" />
        </PageShell>
      </div>
    );
  }
  if (routinesQuery.kind === "error") {
    return <NotFound title={slug} description={routinesQuery.message} />;
  }
  if (matches.length > 1) {
    return (
      <NotFound
        title={slug}
        description="More than one routine answers to this name. Rename one of them so each has its own address."
      />
    );
  }
  if (row === undefined) {
    return (
      <NotFound
        title={slug}
        description="No routine in your workbenches answers to this name."
      />
    );
  }

  const resolved = row;
  return (
    <RoutineDetailPage
      row={resolved}
      now={now}
      workflowName={workflowName}
      onRunNow={async () => {
        await runRoutineNow(resolved.tenantId, resolved.routine.id);
        invalidate(resolved.tenantId);
        toast(routineRunStartedToast(resolved.routine.name));
      }}
      onToggleEnabled={(enabled) => {
        void updateRoutine(resolved.tenantId, resolved.routine.id, {
          enabled,
        }).then(() => invalidate(resolved.tenantId));
      }}
      onSaveSchedule={async (expression) => {
        const timezone = timezoneForTrigger(resolved.routine.trigger);
        await updateRoutine(resolved.tenantId, resolved.routine.id, {
          trigger:
            timezone === "UTC"
              ? { kind: "cron", expression }
              : { kind: "cron", expression, timezone },
        });
        invalidate(resolved.tenantId);
      }}
    />
  );
}
