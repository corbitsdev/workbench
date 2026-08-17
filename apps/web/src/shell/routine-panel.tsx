// The routine panel (CL-6125, reworked CL-6139): a two-view master-detail
// pane in the canvas column, beside the conversation — never a route hop.
// `RoutinePanel` branches on the subject's `view`:
//
//   - list (the default, and the header's Routines affordance / `/run`):
//     this workbench's active routines, name · cadence · Active toggle,
//     with a "New routine" row at the top. `RoutineListPanel`.
//   - editor (a specific routine, or a brand-new one): the same fields
//     this pane has always had. `RoutineEditorPanel`.
//
// Back from the editor returns to the list; back from the list closes the
// canvas — one back-chevron affordance the whole way down, the same
// master-detail shape `ProfileCanvasPane`/`ArtifactCanvasPane` establish
// elsewhere in this column.
//
// There is no Save button — every field autosaves on blur/select, and
// every write (create or update) is serialized through one queue
// (`runWrite` in `RoutineEditorPanel`) so two near-simultaneous commits —
// Name's blur and Instruction's blur landing in the same tick, say — can
// never both decide "no routine yet, create one" and fire two POSTs. The
// second write's create-vs-update decision is made only once the first
// has actually finished, not from a state snapshot taken before either
// ran. `saveState` ("saving…" / "saved" / an honest inline error) reflects
// that same queue, not any individual field's own fetch.
//
// A routine created from this panel always targets the conversation it
// was opened beside: every workbench's host participant is Myra, so "this
// workbench's own agent" resolves to that channel's host agent
// (`listChannelAgents`), and the routine delivers back into that same
// channel — never a new one. A panel opened with no channel in scope (a
// deliberate `/routines` visit) falls back to the workbench's own default
// Myra channel (`ensureMyraChannel`, the one deliberate find-or-create
// path in the product) rather than the old tenant-wide "assistant"
// definition lookup, which had no channel to deliver into at all and
// silently minted a fresh one server-side whenever delivery was required.
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  ConfirmButton,
  EmptyState,
  formatRelativeTime,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  RichEmptyState,
  RunNowButton,
  Skeleton,
  StatusDot,
  Switch,
  toast,
  TraceWaterfall,
} from "@corbits/react-ui";
import type { BadgeTone, StatusDotTone } from "@corbits/react-ui";
import { listChannelAgents } from "@corbits/chat-ui";
import { listTasks } from "@corbits/tasks-ui";
import type { Task, TaskStatus } from "@corbits/tasks-ui";
import { ChevronLeft, Clock, Plus, X } from "lucide-react";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { ensureMyraChannel } from "../myra-channel";
import { cadenceLabel, cadenceSummary } from "../routine-trigger";
import { ScheduleEditor } from "../routine-schedule";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutineRuns,
  listRoutines,
  routineCreatedToast,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
  useTenantQuery,
} from "../routines-api";
import type { Routine, RoutineRun, RoutineTrigger } from "../routines-api";
import {
  insightsRunTracePath,
  insightsTopLevelRunsPath,
  RunTraceSchema,
  TopLevelRunsSchema,
} from "../insights-api";
import type { InsightsRun } from "../insights-api";
import { RunsTable } from "../pages/routines-page";
import {
  formatWhen,
  runDurationLabel,
  statusTone,
  toTraceSpans,
} from "../pages/insights-page";
import {
  createWebhookTrigger,
  DEFAULT_WEBHOOK_INPUT_TEMPLATE,
} from "../webhook-triggers-api";
import { useDeploymentCapabilities } from "../deployment-capabilities-api";
import { tenantKeys } from "../query-client";
import {
  useCanvasColumnRoutine,
  useCloseCanvas,
  useOpenRoutineInCanvas,
} from "./canvas-availability";
import type { RoutinePanelSubject } from "./canvas-availability";

function instructionFromInput(input: Record<string, unknown>): string {
  const value = input["instruction"];
  return typeof value === "string" ? value : "";
}

/** A trigger's row summary — `sourceLabel` (this panel session's own memory
 * of which "+ Add trigger" option minted a webhook trigger) wins over the
 * generic cadence label for a webhook, since a freshly-reloaded panel has
 * no way to recover which source it was bound to. */
function triggerRowSummary(
  trigger: Exclude<RoutineTrigger, null>,
  sourceLabel: string | null,
): string {
  if (trigger.kind === "webhook") return sourceLabel ?? "On webhook";
  return cadenceLabel(trigger);
}

/**
 * `+ Add trigger` popover contents: schedule is always offered; Granola
 * call notes is a plain inbound webhook binding (no external credential —
 * Granola pushes to us), so it's always offered too; Slack is offered only
 * when this deployment's Slack tag ingress is actually mounted (see
 * `deployment-capabilities-api.ts`) — an unconfigured deployment must never
 * offer a trigger that can't honestly fire.
 */
function AddTriggerMenu({
  slackAvailable,
  onSchedule,
  onGranola,
  onSlack,
  disabled,
}: {
  readonly slackAvailable: boolean;
  readonly onSchedule: () => void;
  readonly onGranola: () => void;
  readonly onSlack: () => void;
  readonly disabled: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          + Add trigger
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onSchedule}>On a schedule ›</MenuItem>
        <MenuItem onSelect={onGranola}>Granola call notes</MenuItem>
        {slackAvailable ? <MenuItem onSelect={onSlack}>Slack</MenuItem> : null}
      </MenuContent>
    </Menu>
  );
}

export function RoutinePanel() {
  const subject = useCanvasColumnRoutine();
  const close = useCloseCanvas();
  const openRoutine = useOpenRoutineInCanvas();

  if (subject === null || subject.view === "list") {
    return (
      <RoutineListPanel
        onClose={close}
        onSelect={(routineId) =>
          openRoutine({
            routineId,
            ...(subject?.channelId !== undefined
              ? { channelId: subject.channelId }
              : {}),
          })
        }
        onNew={() =>
          openRoutine({
            routineId: null,
            ...(subject?.channelId !== undefined
              ? { channelId: subject.channelId }
              : {}),
          })
        }
        onOpenRuns={() =>
          openRoutine({
            view: "runs",
            ...(subject?.channelId !== undefined
              ? { channelId: subject.channelId }
              : {}),
          })
        }
      />
    );
  }

  if (subject.view === "runs") {
    return (
      <RunsCanvasPanel
        onBack={() =>
          openRoutine({
            view: "list",
            ...(subject.channelId !== undefined
              ? { channelId: subject.channelId }
              : {}),
          })
        }
      />
    );
  }

  return (
    <RoutineEditorPanel
      subject={subject}
      onBack={() =>
        openRoutine({
          view: "list",
          ...(subject.channelId !== undefined
            ? { channelId: subject.channelId }
            : {}),
        })
      }
      onClose={close}
    />
  );
}

/** The panel's default view: this workbench's active routines, a "New
 * routine" row at the top, name · cadence · Active toggle per row. */
/** A run's own embedded status field — `RoutineRun.run` is an opaque
 * `Record<string, unknown>` (whatever the launched workflow run reports),
 * `"status"` is the one key `RunsTable` already reads from it. */
function embeddedRunStatus(run: RoutineRun): string | undefined {
  const status = run.run?.["status"];
  return typeof status === "string" ? status : undefined;
}

function runFailed(run: RoutineRun): boolean {
  return (
    (run.error !== undefined && run.error !== null) ||
    embeddedRunStatus(run) === "failed"
  );
}

/** Best-effort one-line outcome for a finished run: the run's own error
 * when it has one, else the first plausible reply/summary field the
 * embedded run record carries, else an honest "Completed." — never a
 * fabricated excerpt when the data has none. */
function runOutcomeExcerpt(run: RoutineRun): string {
  if (run.error !== undefined && run.error !== null) return run.error;
  const record = run.run;
  if (record !== undefined) {
    for (const key of ["reply", "summary", "output", "result"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.length > 140 ? `${value.slice(0, 140)}…` : value;
      }
    }
  }
  return "Completed.";
}

type StatusChip = {
  readonly label: string;
  readonly tone: StatusDotTone;
  readonly live: boolean;
};

/** `StatusDot` marks liveness only — its own doc comment is explicit that
 * a `Badge` is what names the state visibly. `StatusDotTone` and
 * `BadgeTone` are two different enums (`"emphasis"` vs. `"accent"`);
 * every other tone name is shared. */
function badgeToneFor(tone: StatusDotTone): BadgeTone {
  return tone === "emphasis" ? "accent" : tone;
}

/** The chip both components together render: a live/pulsing dot plus the
 * visible, colour-matched label naming the state. */
function StatusChipView({ chip }: { readonly chip: StatusChip }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot label={chip.label} tone={chip.tone} live={chip.live} />
      <Badge tone={badgeToneFor(chip.tone)}>{chip.label}</Badge>
    </span>
  );
}

/** "Idle · Running now (elapsed) · Last run OK Xm ago · Last run failed" —
 * the routine row's live state, computed from its own run history (no
 * separate live-run correlation needed: each `RoutineRun` already embeds
 * the launched run's own status). `runningOverride` is the optimistic
 * "I just clicked Run now" flip — true the instant the click lands, before
 * the server has even accepted the request, let alone reported back. */
function routineStatusChip(
  runs: readonly RoutineRun[],
  runningOverride: boolean,
  now: number,
): StatusChip {
  if (runningOverride)
    return { label: "Running now", tone: "neutral", live: true };
  const latest = runs[0];
  if (latest === undefined)
    return { label: "Idle", tone: "neutral", live: false };
  if (embeddedRunStatus(latest) === "running") {
    return {
      label: `Running now · ${formatRelativeTime(latest.createdAt, now)}`,
      tone: "neutral",
      live: true,
    };
  }
  if (runFailed(latest)) {
    return { label: "Last run failed", tone: "danger", live: false };
  }
  return {
    label: `Last run OK ${formatRelativeTime(latest.createdAt, now)}`,
    tone: "success",
    live: false,
  };
}

/** Polls run history for this routine until the newest run leaves
 * "running", or gives up after `attempts` — the honest "when the run
 * ends" signal a Run now click needs, since the create/run response
 * itself only confirms the launch was accepted, not that it finished. */
async function pollForOutcome(
  tenantId: string,
  routineId: string,
  attempts = 6,
  delayMs = 300,
): Promise<RoutineRun | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = await listRoutineRuns(tenantId, routineId);
    const latest = runs[0];
    if (latest !== undefined && embeddedRunStatus(latest) !== "running") {
      return latest;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const runs = await listRoutineRuns(tenantId, routineId);
  return runs[0] ?? null;
}

function RoutineListPanel({
  onClose,
  onSelect,
  onNew,
  onOpenRuns,
}: {
  readonly onClose: () => void;
  readonly onSelect: (routineId: string) => void;
  readonly onNew: () => void;
  readonly onOpenRuns: () => void;
}) {
  const navigate = useNavigate();
  const { selectedTenantId: tenantId } = useBench();
  const queryClient = useQueryClient();
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, RoutineRun>>(
    new Map(),
  );

  const routinesQuery = useTenantQuery(
    tenantKeys.routines(tenantId ?? ""),
    tenantId !== null,
    () => listRoutines(tenantId as string),
  );
  const routines = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const routineIds = routines.map((r) => r.id);
  const runHistoriesQuery = useTenantQuery<
    ReadonlyMap<string, readonly RoutineRun[]>
  >(
    tenantId === null
      ? (["tenant", "none", "routine-run-histories-panel"] as const)
      : [
          ...tenantKeys.routineRunHistories(tenantId),
          "panel",
          routineIds.join(","),
        ],
    tenantId !== null && routineIds.length > 0,
    async () => {
      const entries = await Promise.all(
        routineIds.map(
          async (id) =>
            [id, await listRoutineRuns(tenantId as string, id)] as const,
        ),
      );
      return new Map(entries);
    },
  );
  const runHistories =
    runHistoriesQuery.kind === "ready" ? runHistoriesQuery.data : new Map();

  function toggle(routine: Routine, enabled: boolean) {
    if (tenantId === null) return;
    setPendingToggleId(routine.id);
    void updateRoutine(tenantId, routine.id, { enabled })
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.routines(tenantId),
        });
      })
      .finally(() => setPendingToggleId(null));
  }

  function runNow(routine: Routine): Promise<void> {
    if (tenantId === null) return Promise.resolve();
    setRunningIds((prev) => new Set(prev).add(routine.id));
    setOutcomes((prev) => {
      const next = new Map(prev);
      next.delete(routine.id);
      return next;
    });
    return runRoutineNow(tenantId, routine.id)
      .then(() => pollForOutcome(tenantId, routine.id))
      .then((outcome) => {
        if (outcome !== null) {
          setOutcomes((prev) => new Map(prev).set(routine.id, outcome));
        }
      })
      .finally(() => {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(routine.id);
          return next;
        });
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.routineRunHistories(tenantId),
        });
      });
  }

  return (
    <div className="shell-routine-pane flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium">Routines</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpenRuns}>
          Runs
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <button
          type="button"
          className="flex items-center gap-2 border-b border-[var(--ui-border)] px-3 py-2 text-left text-sm font-medium"
          onClick={onNew}
        >
          <Plus className="size-4" />
          New routine
        </button>
        {routinesQuery.kind === "loading" ? (
          <Skeleton className="query-skeleton" />
        ) : routinesQuery.kind === "ready" ? (
          routines.length === 0 ? (
            <EmptyState
              icon={<Clock />}
              title="No routines yet"
              description="Create one to automate this workbench."
            />
          ) : (
            routines.map((routine) => {
              const runs = runHistories.get(routine.id) ?? [];
              const chip = routineStatusChip(
                runs,
                runningIds.has(routine.id),
                Date.now(),
              );
              const outcome = outcomes.get(routine.id);
              return (
                <div
                  key={routine.id}
                  className="border-b border-[var(--ui-border)]"
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                      onClick={() => onSelect(routine.id)}
                    >
                      <span className="truncate text-sm font-medium">
                        {routine.name}
                      </span>
                      <span className="truncate text-xs text-[var(--ui-fg-muted)]">
                        {cadenceSummary(routine.trigger)}
                      </span>
                    </button>
                    <StatusChipView chip={chip} />
                    <RunNowButton
                      variant="ghost"
                      size="sm"
                      disabled={runningIds.has(routine.id)}
                      onRun={() => runNow(routine)}
                    />
                    <Switch
                      checked={routine.enabled}
                      disabled={pendingToggleId === routine.id}
                      label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                      onCheckedChange={(enabled) => toggle(routine, enabled)}
                    />
                  </div>
                  {outcome !== undefined ? (
                    <div className="flex items-center justify-between gap-2 bg-[var(--ui-bg-subtle)] px-3 py-1.5 text-xs">
                      <span
                        className={
                          runFailed(outcome)
                            ? "text-[var(--ui-danger)]"
                            : "text-[var(--ui-fg-muted)]"
                        }
                      >
                        {runOutcomeExcerpt(outcome)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate("/insights/runs")}
                      >
                        Open trace →
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )
        ) : (
          <EmptyState
            icon={<Clock />}
            title="Couldn't load routines"
            description="Try again in a moment."
          />
        )}
        {tenantId !== null ? (
          <TasksSection tenantId={tenantId} navigate={navigate} />
        ) : null}
      </div>
    </div>
  );
}

function runStatusDotTone(status: string): StatusDotTone {
  const tone = statusTone(status);
  if (tone === "danger") return "danger";
  if (tone === "success" || tone === "info") return "emphasis";
  return "neutral";
}

/** This workbench's own runs — its agent runs and its routines' runs
 * (`insightsTopLevelRunsPath` is already tenant-scoped, so a workbench's
 * runs are exactly this bench's top-level feed) — each row opening the
 * same `TraceWaterfall` insights renders, inline in this pane: no route
 * hop out of `/c/:id`. Selection is local state, not canvas subject state
 * — a click into a trace and back never touches the shell's own history. */
function RunsCanvasPanel({ onBack }: { readonly onBack: () => void }) {
  const { selectedTenantId: tenantId } = useBench();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useAPIQuery(
    tenantId === null ? "" : insightsTopLevelRunsPath(tenantId),
    TopLevelRunsSchema,
  );
  const runs: readonly InsightsRun[] =
    runsQuery.kind === "ready" ? runsQuery.data.data : [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const traceQuery = useAPIQuery(
    tenantId === null || selectedRunId === null
      ? ""
      : insightsRunTracePath(tenantId, selectedRunId),
    RunTraceSchema,
  );

  if (selectedRunId !== null) {
    const spans =
      traceQuery.kind === "ready" ? toTraceSpans(traceQuery.data) : [];
    return (
      <div className="shell-routine-pane flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--ui-border)] px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedRunId(null)}
            aria-label="Back to runs"
            title="Back to runs"
          >
            <ChevronLeft />
          </Button>
          <span className="truncate text-sm font-medium">
            {selectedRun?.definitionName ?? selectedRunId}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {traceQuery.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : null}
          {traceQuery.kind === "ready" && spans.length > 0 ? (
            <TraceWaterfall
              title="Run trace"
              spans={spans}
              description={`${spans.length} span${spans.length === 1 ? "" : "s"}`}
            />
          ) : null}
          {traceQuery.kind === "ready" && spans.length === 0 ? (
            <RichEmptyState
              title="Empty trace"
              description="The run exists but has no recorded spans yet."
            />
          ) : null}
          {traceQuery.kind === "error" ? (
            <RichEmptyState
              title="Trace not available"
              description={traceQuery.message}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="shell-routine-pane flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--ui-border)] px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft />
        </Button>
        <span className="text-sm font-medium">Runs</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {runsQuery.kind === "loading" ? (
          <Skeleton className="query-skeleton" />
        ) : runsQuery.kind === "ready" && runs.length === 0 ? (
          <EmptyState
            icon={<Clock />}
            title="No runs yet."
            description="This workbench's agent and routine runs will show up here."
          />
        ) : runsQuery.kind === "ready" ? (
          runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className="flex items-center gap-2 border-b border-[var(--ui-border)] px-3 py-2 text-left"
              onClick={() => setSelectedRunId(run.id)}
            >
              <StatusDot
                label={run.status}
                tone={runStatusDotTone(run.status)}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {run.definitionName}
              </span>
              <span className="shrink-0 text-xs text-[var(--ui-fg-muted)]">
                {formatWhen(run.createdAt)}
              </span>
              <span className="shrink-0 text-xs text-[var(--ui-fg-muted)]">
                {runDurationLabel(run)}
              </span>
            </button>
          ))
        ) : (
          <EmptyState
            icon={<Clock />}
            title="Couldn't load runs"
            description="Try again in a moment."
          />
        )}
      </div>
    </div>
  );
}

/** "Tasks" section: this workbench's in-flight and recent tasks
 * (`@corbits/tasks-ui`'s own row/status vocabulary), the same
 * verify-by-running story the routines list above tells — a task's
 * outcome shows inline the moment it lands, not just in Insights. */
function TasksSection({
  tenantId,
  navigate,
}: {
  readonly tenantId: string;
  readonly navigate: (path: string) => void;
}) {
  const tasksQuery = useTenantQuery(tenantKeys.tasks(tenantId), true, () =>
    listTasks(tenantId),
  );
  const tasks =
    tasksQuery.kind === "ready"
      ? [...tasksQuery.data]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 10)
      : [];

  return (
    <div className="mt-2 border-t border-[var(--ui-border)]">
      <div className="px-3 py-2">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
          Tasks
        </h3>
      </div>
      {tasksQuery.kind === "loading" ? (
        <Skeleton className="query-skeleton" />
      ) : tasks.length === 0 ? (
        <div className="px-3 pb-3">
          <EmptyState
            icon={<Clock />}
            title="No tasks yet"
            description="Run one now to see it here."
          />
        </div>
      ) : (
        tasks.map((task) => (
          <TaskRow key={task.id} task={task} navigate={navigate} />
        ))
      )}
    </div>
  );
}

const TASK_STATUS_CHIP: Record<TaskStatus, StatusChip> = {
  queued: { label: "Queued", tone: "neutral", live: false },
  running: { label: "Running now", tone: "neutral", live: true },
  "needs-you": { label: "Needs you", tone: "emphasis", live: true },
  done: { label: "Last run OK", tone: "success", live: false },
  failed: { label: "Last run failed", tone: "danger", live: false },
};

function TaskRow({
  task,
  navigate,
}: {
  readonly task: Task;
  readonly navigate: (path: string) => void;
}) {
  const chip = TASK_STATUS_CHIP[task.status];
  const terminal = task.status === "done" || task.status === "failed";
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--ui-border)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{task.agentName}</span>
        <StatusChipView chip={chip} />
      </div>
      {terminal ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span
            className={
              task.status === "failed"
                ? "text-[var(--ui-danger)]"
                : "text-[var(--ui-fg-muted)]"
            }
          >
            {task.status === "failed" ? "Failed." : "Done."}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/insights/runs")}
          >
            Open trace →
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

type CreateTarget = {
  readonly definitionId: string;
  readonly deliveryChannelId: string;
};

/** The editor view: create/edit one routine. Self-fetching — handed only
 * the subject, loads the rest itself, exactly like `ProfileCanvasPane`. */
function RoutineEditorPanel({
  subject,
  onBack,
  onClose,
}: {
  readonly subject: RoutinePanelSubject;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const { selectedTenantId: tenantId } = useBench();
  const { slackConfigured } = useDeploymentCapabilities();
  const queryClient = useQueryClient();

  const invalidateRoutines = () => {
    if (tenantId === null) return;
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routines(tenantId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routineRunHistories(tenantId),
    });
  };

  const [routineId, setRoutineId] = useState<string | null>(
    subject.routineId ?? null,
  );
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [savedInstruction, setSavedInstruction] = useState("");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [triggerSourceLabel, setTriggerSourceLabel] = useState<string | null>(
    null,
  );
  const [addingSchedule, setAddingSchedule] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RoutineRun[]>([]);

  // Every write (create or update) this panel session makes runs through
  // this one chain — never two in flight at once. `routineIdRef` is the
  // decision the chained tasks read: it only updates once a write actually
  // resolves, so a second commit queued before the first finished sees the
  // *post*-first-write id, not a stale snapshot from before either ran.
  const routineIdRef = useRef<string | null>(routineId);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  // A new subject (a different routine, or a fresh "New routine") replaces
  // this pane's entire local draft — nothing from the last session leaks
  // into the next, including any write still chained from it.
  useEffect(() => {
    routineIdRef.current = subject.routineId ?? null;
    writeChainRef.current = Promise.resolve();
    setRoutineId(subject.routineId ?? null);
    setName(subject.routineId == null ? (subject.initialName ?? "") : "");
    setSavedName("");
    setInstruction(
      subject.routineId == null ? (subject.initialInstruction ?? "") : "",
    );
    setSavedInstruction("");
    setTrigger(null);
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    setEnabled(false);
    setSaveState("idle");
    setError(null);
    setRuns([]);
  }, [subject]);

  const loadRuns = (id: string) => {
    if (tenantId === null) return;
    void listRoutineRuns(tenantId, id).then(
      (loaded) => setRuns(loaded),
      () => setRuns([]),
    );
  };

  const applyRoutine = (routine: Routine) => {
    setRoutineId(routine.id);
    routineIdRef.current = routine.id;
    setName(routine.name);
    setSavedName(routine.name);
    const loadedInstruction = instructionFromInput(routine.input);
    setInstruction(loadedInstruction);
    setSavedInstruction(loadedInstruction);
    setTrigger(routine.trigger);
    setEnabled(routine.enabled);
  };

  // Loads an existing routine's real fields once the tenant resolves —
  // mirrors `ProfileCanvasPane`'s own "fetch once open" effect.
  useEffect(() => {
    if (tenantId === null || subject.routineId == null) return;
    let cancelled = false;
    void getRoutine(tenantId, subject.routineId).then(
      (routine) => {
        if (cancelled) return;
        applyRoutine(routine);
        loadRuns(routine.id);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, subject.routineId]);

  /** This routine's own agent + delivery channel: the conversation the
   * panel was opened beside (its host participant — every workbench's
   * host is Myra), or, with no conversation in scope, this workbench's
   * own default Myra channel. Never mints a new channel — `ensureMyraChannel`
   * finds-or-creates the one singleton Myra conversation this tenant
   * already has. */
  const resolveCreateTarget = async (): Promise<CreateTarget> => {
    if (tenantId === null) {
      throw new Error("No workbench to create this in yet");
    }
    if (subject.channelId !== undefined) {
      const channelId = subject.channelId;
      const agents = await listChannelAgents(tenantId, channelId);
      const definitionId = agents[0]?.definitionId;
      if (definitionId === undefined) {
        throw new Error(
          "This conversation has no agent to run this routine yet.",
        );
      }
      return { definitionId, deliveryChannelId: channelId };
    }
    const result = await ensureMyraChannel(tenantId);
    if (result.kind === "error") throw new Error(result.message);
    const agents = await listChannelAgents(tenantId, result.channelId);
    const definitionId = agents[0]?.definitionId;
    if (definitionId === undefined) {
      throw new Error(
        "This workbench has no assistant to run this routine yet.",
      );
    }
    return { definitionId, deliveryChannelId: result.channelId };
  };

  /** Every create/update this panel makes funnels through this one chain —
   * `task` reads the *current* routine id only when it actually runs, so
   * two commits queued in the same tick still execute, and decide
   * create-vs-update, strictly one after the other. */
  const runWrite = (
    task: (currentId: string | null) => Promise<Routine>,
  ): Promise<void> => {
    const next = writeChainRef.current.then(async () => {
      setSaveState("saving");
      setError(null);
      try {
        const routine = await task(routineIdRef.current);
        applyRoutine(routine);
        invalidateRoutines();
        setSaveState("saved");
      } catch (cause) {
        setSaveState("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    writeChainRef.current = next;
    return next;
  };

  const doCreate = async (fields: {
    readonly name: string;
    readonly instruction: string;
    readonly trigger: RoutineTrigger;
  }): Promise<Routine> => {
    const target = await resolveCreateTarget();
    const routine = await createRoutine(tenantId as string, {
      name: fields.name,
      definitionId: target.definitionId,
      deliveryChannelId: target.deliveryChannelId,
      scope: "personal",
      trigger: fields.trigger,
      runOnceNow: false,
      ...(fields.instruction.trim() !== ""
        ? { input: { instruction: fields.instruction.trim() } }
        : {}),
    });
    toast(routineCreatedToast(routine.name));
    return routine;
  };

  // The create-vs-update decision is made *inside* each queued task, from
  // the `id` `runWrite` hands it at the moment it actually runs — never
  // from `routineIdRef.current` read here, before either write's turn in
  // the chain. Name's blur and Instruction's blur can both fire in the
  // same tick, both see "no routine yet" at read time here, and both
  // still enqueue — but only the first task to actually execute creates;
  // by the time the second runs, the chain has already applied the first
  // write's result, so it correctly updates instead. The bail-outs below
  // (blank name, unchanged value) are safe to read eagerly — being a tick
  // stale there costs at most one redundant PATCH, never a second POST.
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (routineIdRef.current !== null && trimmed === savedName) return;
    void runWrite((id) => {
      if (id === null) return doCreate({ name: trimmed, instruction, trigger });
      return updateRoutine(tenantId as string, id, { name: trimmed });
    });
  };

  const commitInstruction = () => {
    const trimmed = instruction.trim();
    if (routineIdRef.current === null && name.trim() === "") return;
    if (routineIdRef.current !== null && trimmed === savedInstruction) return;
    void runWrite((id) => {
      if (id === null) {
        return doCreate({ name: name.trim(), instruction, trigger });
      }
      return updateRoutine(tenantId as string, id, {
        input: { instruction: trimmed },
      });
    });
  };

  const commitSchedule = (next: Exclude<RoutineTrigger, null>) => {
    setTrigger(next);
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    void runWrite((id) => {
      if (id === null) {
        return doCreate({
          name: name.trim() || "Untitled routine",
          instruction,
          trigger: next,
        });
      }
      return updateRoutine(tenantId as string, id, { trigger: next });
    });
  };

  const removeTrigger = () => {
    setTrigger(null);
    setTriggerSourceLabel(null);
    void runWrite((id) => {
      if (id === null) {
        return Promise.reject(new Error("No routine to update yet"));
      }
      return updateRoutine(tenantId as string, id, { trigger: null });
    });
  };

  const addWebhookTrigger = (sourceLabel: string) => {
    void runWrite(async (id) => {
      if (tenantId === null) {
        throw new Error("No workbench to create this in yet");
      }
      let targetRoutineId = id;
      let definitionId: string;
      if (targetRoutineId === null) {
        const target = await resolveCreateTarget();
        const created = await createRoutine(tenantId, {
          name: name.trim() || "Untitled routine",
          definitionId: target.definitionId,
          deliveryChannelId: target.deliveryChannelId,
          scope: "personal",
          trigger: null,
          runOnceNow: false,
          ...(instruction.trim() !== ""
            ? { input: { instruction: instruction.trim() } }
            : {}),
        });
        targetRoutineId = created.id;
        definitionId = created.definitionId;
        toast(routineCreatedToast(created.name));
      } else {
        definitionId = (await resolveCreateTarget()).definitionId;
      }
      const binding = await createWebhookTrigger(tenantId, {
        name: `${name.trim() || "Untitled routine"} — ${sourceLabel}`,
        workflowDefinitionId: definitionId,
        inputTemplate: DEFAULT_WEBHOOK_INPUT_TEMPLATE,
      });
      setTriggerSourceLabel(sourceLabel);
      return updateRoutine(tenantId, targetRoutineId, {
        trigger: { kind: "webhook", webhookTriggerId: binding.id },
      });
    });
  };

  const toggleActive = (next: boolean) => {
    setEnabled(next);
    void runWrite((id) => {
      if (id === null) {
        setEnabled(!next);
        return Promise.reject(new Error("No routine to update yet"));
      }
      return updateRoutine(tenantId as string, id, { enabled: next }).catch(
        (cause: unknown) => {
          setEnabled(!next);
          throw cause;
        },
      );
    });
  };

  const busy = saveState === "saving";

  return (
    <div className="shell-routine-pane flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium">Routine</span>
        </div>
        {saveState === "saving" ? (
          <span className="text-xs text-[var(--ui-fg-muted)]" role="status">
            Saving…
          </span>
        ) : saveState === "saved" ? (
          <span className="text-xs text-[var(--ui-fg-muted)]" role="status">
            Saved
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <Switch
          checked={enabled}
          disabled={routineId === null || busy}
          label={`${enabled ? "Pause" : "Resume"} ${name || "this routine"}`}
          onCheckedChange={toggleActive}
        />
        {routineId !== null ? (
          <ConfirmButton
            variant="outline"
            size="sm"
            confirmLabel="Delete this routine — click again to confirm"
            onConfirm={() => {
              if (tenantId === null || routineId === null) return;
              void deleteRoutine(tenantId, routineId).then(() => {
                invalidateRoutines();
                onClose();
              });
            }}
          >
            Delete
          </ConfirmButton>
        ) : null}
        <RunNowButton
          variant="outline"
          size="sm"
          disabled={routineId === null}
          onRun={() => {
            if (tenantId === null || routineId === null) return;
            return runRoutineNow(tenantId, routineId).then(() => {
              toast(routineRunStartedToast(name));
              loadRuns(routineId);
              invalidateRoutines();
            });
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routine-panel-name" className="text-xs font-medium">
            Name this routine
          </label>
          <Input
            id="routine-panel-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="routine-panel-instruction"
            className="text-xs font-medium"
          >
            What should this routine do each time it runs?
          </label>
          <textarea
            id="routine-panel-instruction"
            className="min-h-20 w-full rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg)] px-2.5 py-1.5 text-sm text-[var(--ui-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-accent)]"
            value={instruction}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setInstruction(event.target.value)
            }
            onBlur={commitInstruction}
          />
        </div>

        {error !== null ? (
          <p className="text-xs text-[var(--ui-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">When to run</span>
          {trigger === null && !addingSchedule ? (
            <AddTriggerMenu
              slackAvailable={slackConfigured}
              disabled={busy}
              onSchedule={() => setAddingSchedule(true)}
              onGranola={() => addWebhookTrigger("Granola call notes")}
              onSlack={() => addWebhookTrigger("Slack")}
            />
          ) : trigger === null && addingSchedule ? (
            <ScheduleEditor
              value={null}
              onChange={commitSchedule}
              disabled={busy}
            />
          ) : trigger !== null && trigger.kind === "webhook" ? (
            <div className="flex items-center justify-between gap-2 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] px-2.5 py-1.5 text-sm">
              <span>{triggerRowSummary(trigger, triggerSourceLabel)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove trigger"
                onClick={removeTrigger}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : trigger !== null ? (
            <div className="flex flex-col gap-2">
              <ScheduleEditor
                value={trigger}
                onChange={commitSchedule}
                disabled={busy}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove trigger"
                  onClick={removeTrigger}
                >
                  <X className="size-3.5" /> Remove
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <section aria-label="Run history">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
              Run history
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate("/insights/runs")}
            >
              Insights →
            </Button>
          </div>
          {routineId === null ? (
            <EmptyState
              icon={<Clock />}
              title="No runs yet"
              description="Save this routine to see it here."
            />
          ) : (
            <RunsTable
              runs={runs.slice(0, 10)}
              now={Date.now()}
              emptyTitle="No runs yet"
              emptyDescription="This routine has not fired yet — manually or on a schedule."
            />
          )}
        </section>
      </div>
    </div>
  );
}
