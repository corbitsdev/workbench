// `/routines/<id>` — a routine's own page (CL-6418), replacing the
// placeholder CL-6412 routed here. The id is the address (see
// `resolveRoutineSegment` at the bottom for why, and for how a name still
// resolves onto it).
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
} from "@corbits/react-ui";
import { Clock, FlowArrow } from "@corbits/icons";
import { useEffect, useState, type ReactNode } from "react";
import {
  isValidCronExpression,
  cronExpressionForTrigger,
  cronSentence,
  fireNeverStarted,
  routineHealth,
  routineScheduleSentence,
  timezoneForTrigger,
} from "@corbits/routines/client";
import type { RoutineHealth } from "@corbits/routines/client";

import {
  routineDetailPath,
  rowsForSlug,
  useGlobalRoutines,
  useRoutineActions,
} from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { runDetailPath } from "../insights-deeplinks";
import { Link } from "../navigation";
import { ROUTINES_PATH_PREFIX } from "../path-ids";
import { ROUTINE_HEALTH_TONE } from "../routine-health-tone";
import { useOpenRoutineInCanvas } from "../shell/canvas-availability";
import { StageTopBar } from "../shell/stage-top-bar";
import { nextRunLabel, RunStatusCell, TriggeredByCell } from "./routines-page";
import { listWorkflowDefinitions, useTenantQuery } from "../routines-api";
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
      {/* Both read exactly what the list's own columns read —
          `nextRunLabel` off the scheduler's clock, `health.lastRunAt` off
          the newest history row — so a routine cannot report "never run"
          here beside a history table full of runs. */}
      <RailFact label="Next run">{nextRunLabel(row, now)}</RailFact>
      <RailFact label="Last run">
        {health.lastRunAt === null
          ? "Never"
          : formatRelativeTime(health.lastRunAt, now)}
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
 * what their change means before they save it.
 *
 * Saveable means two things, and both are the same question — "will this
 * do what it reads like?": the scheduler's own parser must accept it
 * (`isValidCronExpression`, the check the server saves against) *and* it
 * must be describable, because an expression this page cannot put into
 * words is one the person cannot check before committing to it. Whatever
 * the field's whitespace, exactly one trimmed expression is compared,
 * previewed, and sent.
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
  const [failure, setFailure] = useState<string | null>(null);
  const expression = draft.trim();
  const preview = isValidCronExpression(expression)
    ? cronSentence(expression, timezone)
    : null;
  const changed = stored !== null && expression !== stored;

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
              disabled={preview === null || !changed || saving}
              onClick={() => {
                setSaving(true);
                setFailure(null);
                void onSave(expression)
                  .catch(() => {
                    // `useRoutineActions` already said what went wrong in
                    // a toast; this keeps it on screen next to the field
                    // the person is still holding.
                    setFailure("Not saved — the schedule is unchanged.");
                  })
                  .finally(() => setSaving(false));
              }}
            >
              Save schedule
            </Button>
          </div>
          <p className="m-0 text-xs text-[var(--ui-fg-muted)]">
            {failure ?? preview ?? "That isn't a schedule this can run."}
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
                  <RunStatusCell run={run} now={now} />
                </TableCell>
                <TableCell>{formatRelativeTime(run.createdAt, now)}</TableCell>
                <TableCell>
                  {fireNeverStarted(run.triggeredBy) ? (
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
  onEdit,
}: {
  readonly row: GlobalRoutineRow;
  readonly now: number;
  readonly workflowName: string;
  readonly onRunNow: () => Promise<void>;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onSaveSchedule: (expression: string) => Promise<void>;
  readonly onEdit: () => void;
}) {
  const health = routineHealth(row.routine, row.runs, now);
  const latestRunId =
    row.runs.find((run) => !fireNeverStarted(run.triggeredBy))?.runId ?? null;
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
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              Edit
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

/** A routine-shaped screen with nothing to show: the trail still reads
 * Routines, and the way out is a link, never a dead end. */
function RoutineNotice({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
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
        {children}
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

/**
 * What `/routines/<segment>` resolves to.
 *
 * The id is the canonical address and renders the page directly — a
 * routine has no slug column, so a name-derived slug is exactly the "soft
 * convention a migration can violate" DESIGN.md forbids in a route, and
 * the opaque id is the fallback that section prescribes. A name still
 * resolves, as a convenience: it redirects to the id path, so what ends
 * up in the address bar, in a bookmark, and in a shared link is the
 * address that cannot break when someone renames the routine.
 *
 * A name two routines answer to resolves to neither — it offers both by
 * id instead. A segment nothing answers to says the routine is gone,
 * rather than quietly showing the roster under a URL that no longer means
 * anything.
 */
export type RoutineResolution =
  | { readonly kind: "found"; readonly row: GlobalRoutineRow }
  | { readonly kind: "redirect"; readonly to: string }
  | { readonly kind: "ambiguous"; readonly rows: readonly GlobalRoutineRow[] }
  | { readonly kind: "gone" };

export function resolveRoutineSegment(
  rows: readonly GlobalRoutineRow[],
  segment: string,
): RoutineResolution {
  const byId = rows.find((row) => row.routine.id === segment);
  if (byId !== undefined) return { kind: "found", row: byId };
  const byName = rowsForSlug(rows, segment);
  const only = byName.length === 1 ? byName[0] : undefined;
  if (only !== undefined) {
    return { kind: "redirect", to: routineDetailPath(only.routine.id) };
  }
  if (byName.length > 1) return { kind: "ambiguous", rows: byName };
  return { kind: "gone" };
}

export function RoutineDetailRoute({
  segment,
  navigate,
}: {
  readonly segment: string;
  readonly navigate: (to: string) => void;
}) {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const openRoutine = useOpenRoutineInCanvas();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const resolution = resolveRoutineSegment(rows, segment);
  const row = resolution.kind === "found" ? resolution.row : undefined;
  const workflowName = useWorkflowName(row);
  const now = Date.now();
  const redirectTo =
    routinesQuery.kind === "ready" && resolution.kind === "redirect"
      ? resolution.to
      : null;

  useEffect(() => {
    if (redirectTo === null) return;
    navigate(redirectTo);
  }, [redirectTo, navigate]);

  if (routinesQuery.kind === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={[
            { label: "Routines", href: ROUTINES_PATH_PREFIX },
            { label: segment },
          ]}
        />
        <PageShell width="full" className="page-fill">
          <EmptyState icon={<Clock />} title="Loading routine…" />
        </PageShell>
      </div>
    );
  }
  if (routinesQuery.kind === "error") {
    return (
      <RoutineNotice title={segment} description={routinesQuery.message} />
    );
  }
  if (resolution.kind === "redirect") {
    return (
      <RoutineNotice
        title={segment}
        description="Opening this routine at its permanent address…"
      />
    );
  }
  if (resolution.kind === "ambiguous") {
    return (
      <RoutineNotice
        title={segment}
        description="More than one routine is named this. Pick the one you meant — each link opens that routine at its permanent address."
      >
        <ul className="mt-4 flex flex-col gap-2">
          {resolution.rows.map((candidate) => (
            <li key={candidate.routine.id}>
              <Link to={routineDetailPath(candidate.routine.id)}>
                {candidate.routine.name} · {candidate.tenantName}
              </Link>
            </li>
          ))}
        </ul>
      </RoutineNotice>
    );
  }
  if (row === undefined) {
    return (
      <RoutineNotice
        title={segment}
        description="That routine is gone — it was deleted, or it lives in a workbench you no longer belong to."
      />
    );
  }

  const resolved = row;
  return (
    <RoutineDetailPage
      row={resolved}
      now={now}
      workflowName={workflowName}
      onRunNow={() => actions.runNow(resolved)}
      onToggleEnabled={(enabled) => {
        void actions.setEnabled(resolved, enabled);
      }}
      onSaveSchedule={(expression) =>
        actions.saveCronSchedule(resolved, expression)
      }
      onEdit={() => openRoutine({ routineId: resolved.routine.id })}
    />
  );
}
