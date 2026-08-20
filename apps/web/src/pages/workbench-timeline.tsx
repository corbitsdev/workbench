// Per-workbench Insights view (CL-6224): one wall-clock spine merging chat
// messages, thread forks, routine runs, tasks, and approvals for a single
// workbench (== workbench, per docs/GLOSSARY.md), oldest to newest with day
// dividers. No new backend — every fetch here is an existing route this app
// already reads elsewhere (chat-ui, routines-api, tasks-ui, api.ts); the new
// work is `../workbench-timeline-merge.ts`'s pure merge, plus this render.

import {
  Badge,
  Button,
  RichEmptyState,
  Skeleton,
  type BadgeTone,
} from "@corbits/react-ui";
import { listMessages, listThreads } from "@corbits/chat-ui";
import { listTasks } from "@corbits/tasks-ui";
import { Clock } from "lucide-react";
import { useMemo, useState } from "react";

import { useAPIQuery, NeedsYouSchema } from "../api";
import {
  listRoutineRuns,
  listRoutines,
  useTenantQuery,
  type RoutineRun,
} from "../routines-api";
import { tenantKeys } from "../query-client";
import {
  computeTimelineDayKpis,
  filterTimelineEvents,
  groupTimelineByDay,
  mergeTimelineEvents,
  routinesForWorkbench,
  toApprovalEvents,
  toMessageEvents,
  toRoutineRunEvents,
  toTaskEvents,
  toThreadForkEvents,
  type TimelineEvent,
  type TimelineFilter,
} from "../workbench-timeline-merge";

const FILTERS: readonly {
  readonly id: TimelineFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "runs", label: "Runs" },
  { id: "approvals", label: "Approvals" },
];

function timeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function routineRunTone(status: "ok" | "failed" | "running"): BadgeTone {
  switch (status) {
    case "ok":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
  }
}

function taskStatusTone(status: string): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "needs-you":
      return "warning";
    default:
      return "info";
  }
}

function markerClass(event: TimelineEvent): string {
  switch (event.kind) {
    case "message":
      return event.isAgent
        ? "workbench-timeline-marker-primary"
        : "workbench-timeline-marker-neutral";
    case "thread-fork":
      return "workbench-timeline-marker-neutral";
    case "routine-run":
      return event.status === "ok"
        ? "workbench-timeline-marker-success"
        : event.status === "failed"
          ? "workbench-timeline-marker-danger"
          : "workbench-timeline-marker-info";
    case "task":
      return "workbench-timeline-marker-info";
    case "approval":
      return "workbench-timeline-marker-warn";
  }
}

function TimelineRowBody({
  event,
  onOpenRun,
}: {
  readonly event: TimelineEvent;
  readonly onOpenRun: (runId: string) => void;
}) {
  switch (event.kind) {
    case "message":
      return (
        <div className="workbench-timeline-entry-body">
          <strong>{event.senderName}</strong>
          <span className="workbench-timeline-entry-excerpt">
            {event.excerpt}
          </span>
        </div>
      );
    case "thread-fork":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            Forked {event.threadKind === "delivery" ? "delivery" : "reply"}{" "}
            thread · {event.title}
          </span>
        </div>
      );
    case "routine-run":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            Routine {event.routineName} ran ·{" "}
            {event.durationMs === null
              ? "duration unknown"
              : `${(event.durationMs / 1000).toFixed(1)}s`}
          </span>
          <Badge tone={routineRunTone(event.status)}>{event.status}</Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenRun(event.runId)}
          >
            Open trace
          </Button>
        </div>
      );
    case "task":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            {event.agentName} ran a task · {event.prompt}
          </span>
          <Badge tone={taskStatusTone(event.status)}>{event.status}</Badge>
        </div>
      );
    case "approval":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            {event.agentName} needs your approval · {event.headline}
          </span>
          <Badge tone="warning">pending</Badge>
        </div>
      );
  }
}

function TimelineRow({
  event,
  onOpenRun,
}: {
  readonly event: TimelineEvent;
  readonly onOpenRun: (runId: string) => void;
}) {
  const indented = event.kind === "thread-fork";
  return (
    <li
      className="workbench-timeline-entry"
      data-indented={indented}
      data-ctx-timeline-event={event.id}
    >
      <span
        className={`workbench-timeline-marker ${markerClass(event)}`}
        aria-hidden="true"
      />
      <span className="workbench-timeline-entry-time">
        {timeOfDay(event.at)}
      </span>
      <TimelineRowBody event={event} onOpenRun={onOpenRun} />
    </li>
  );
}

function DayKpiRow({
  kpi,
}: {
  readonly kpi: ReturnType<typeof computeTimelineDayKpis>[number];
}) {
  return (
    <div className="workbench-timeline-kpi-day">
      <h4>{kpi.label}</h4>
      <dl>
        <div>
          <dt>Messages</dt>
          <dd>{kpi.messages}</dd>
        </div>
        <div>
          <dt>Agent turns</dt>
          <dd>{kpi.agentTurns}</dd>
        </div>
        <div>
          <dt>Routine runs</dt>
          <dd>{kpi.routineRuns}</dd>
        </div>
        <div>
          <dt>Approvals</dt>
          <dd>{kpi.approvals}</dd>
        </div>
      </dl>
    </div>
  );
}

export function WorkbenchTimelineView({
  events,
  loading,
  onOpenRun,
}: {
  readonly events: readonly TimelineEvent[];
  readonly loading: boolean;
  readonly onOpenRun: (runId: string) => void;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const filtered = useMemo(
    () => filterTimelineEvents(events, filter),
    [events, filter],
  );
  const dayGroups = useMemo(() => groupTimelineByDay(filtered), [filtered]);
  const kpis = useMemo(() => computeTimelineDayKpis(events), [events]);

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (events.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="Nothing on this workbench's timeline yet"
        description="Messages, routine runs, tasks, and approvals will show up here as they happen."
      />
    );
  }

  return (
    <div className="workbench-timeline">
      <div
        className="workbench-timeline-filters"
        role="group"
        aria-label="Timeline filter"
      >
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            data-active={filter === option.id}
            className="workbench-timeline-filter-option"
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="workbench-timeline-body">
        <div className="workbench-timeline-spine">
          {dayGroups.length === 0 ? (
            <p className="insights-note">No events match this filter.</p>
          ) : (
            dayGroups.map((day) => (
              <section key={day.day} className="workbench-timeline-day">
                <div className="workbench-timeline-day-divider">
                  <span>{day.label}</span>
                </div>
                <ol className="workbench-timeline-rail">
                  {day.events.map((event) => (
                    <TimelineRow
                      key={`${event.kind}-${event.id}`}
                      event={event}
                      onOpenRun={onOpenRun}
                    />
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
        <aside className="workbench-timeline-kpis">
          <h3>Daily activity</h3>
          {kpis.map((kpi) => (
            <DayKpiRow key={kpi.day} kpi={kpi} />
          ))}
        </aside>
      </div>
    </div>
  );
}

/**
 * Fetch composition for one workbench's Timeline. `benchTenantId` is the
 * owning bench — chat's own workbench-tenancy keeps messages/threads
 * addressed at the parent bench's tenant id even though the workbench also
 * mints its own workbench tenant (see docs/workbench-tenancy.md) — while
 * `workbenchId` is the workbench's own id, resolved to that workbench tenant
 * one level up in `InsightsWorkbenchPage` (`../insights-workbench-scope.ts`)
 * for the tenant-scoped Insights endpoints; this component only ever reads
 * messages/threads/routines/tasks/approvals off the owning bench.
 */
export function WorkbenchTimelineRoute({
  benchTenantId,
  workbenchId,
  onOpenRun,
}: {
  readonly benchTenantId: string | null;
  readonly workbenchId: string;
  readonly onOpenRun: (runId: string) => void;
}) {
  const messagesQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "chat", "workbenches", workbenchId, "messages"]
      : tenantKeys.workbenchMessages(benchTenantId, workbenchId),
    benchTenantId !== null,
    () =>
      listMessages(benchTenantId as string, workbenchId).then(
        (page) => page.items,
      ),
  );
  const threadsQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "chat", "workbenches", workbenchId, "threads"]
      : tenantKeys.workbenchThreads(benchTenantId, workbenchId),
    benchTenantId !== null,
    () =>
      listThreads(benchTenantId as string, workbenchId).then(
        (page) => page.items,
      ),
  );
  const routinesQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "routines"]
      : tenantKeys.routines(benchTenantId),
    benchTenantId !== null,
    () => listRoutines(benchTenantId as string),
  );
  const routines =
    routinesQuery.kind === "ready"
      ? routinesForWorkbench(routinesQuery.data, workbenchId)
      : [];
  const routineRunsQuery = useTenantQuery<
    ReadonlyMap<string, readonly RoutineRun[]>
  >(
    benchTenantId === null
      ? ["tenant", "none", "workbench-timeline-routine-runs", workbenchId]
      : tenantKeys.workbenchTimelineRoutineRuns(benchTenantId, workbenchId),
    benchTenantId !== null && routines.length > 0,
    async () => {
      const entries = await Promise.all(
        routines.map(
          async (routine) =>
            [
              routine.id,
              await listRoutineRuns(benchTenantId as string, routine.id),
            ] as const,
        ),
      );
      return new Map(entries);
    },
  );
  const tasksQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "tasks"]
      : tenantKeys.tasks(benchTenantId),
    benchTenantId !== null,
    () => listTasks(benchTenantId as string),
  );
  const approvalsQuery = useAPIQuery(
    benchTenantId === null
      ? ""
      : `/api/tenants/${benchTenantId}/approvals/needs-you`,
    NeedsYouSchema,
  );

  const loading =
    messagesQuery.kind === "loading" ||
    threadsQuery.kind === "loading" ||
    routinesQuery.kind === "loading" ||
    tasksQuery.kind === "loading" ||
    approvalsQuery.kind === "loading";

  const messages = messagesQuery.kind === "ready" ? messagesQuery.data : [];
  const threads = threadsQuery.kind === "ready" ? threadsQuery.data : [];
  const routineRunsByRoutineId =
    routineRunsQuery.kind === "ready" ? routineRunsQuery.data : new Map();
  const tasks = tasksQuery.kind === "ready" ? tasksQuery.data : [];
  // needs-you carries no workbench/workbench id (a known v1 gap — see
  // workbench-timeline-merge.ts's toApprovalEvents), so this is every
  // pending approval on the owning bench, not just this workbench's own.
  const approvals =
    approvalsQuery.kind === "ready" ? approvalsQuery.data.items : [];

  const events = mergeTimelineEvents({
    messages: toMessageEvents(messages),
    threadForks: toThreadForkEvents(threads),
    routineRuns: toRoutineRunEvents(routines, routineRunsByRoutineId),
    tasks: toTaskEvents(tasks, workbenchId),
    approvals: toApprovalEvents(approvals),
  });

  return (
    <WorkbenchTimelineView
      events={events}
      loading={loading}
      onOpenRun={onOpenRun}
    />
  );
}
