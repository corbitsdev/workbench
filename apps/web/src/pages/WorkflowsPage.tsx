import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { ScheduledTrigger, WorkflowCatalogEntry } from "@workbench/shared";
import { AppPageChromeRow, Button } from "@workbench/ui";
import { toHumanLabel } from "@workbench/ui";
import { Plus, Search } from "lucide-react";
import {
  FilterChip,
  InspectorEmpty,
  InspectorShell,
  WorkflowsList,
  type LiveRunPhase,
  type WorkflowListItem,
  type WorkflowScope,
  type WorkflowStatusTone,
} from "@workbench/workflows-ui/react";
import { WorkflowRunPane } from "../components/WorkflowRunPane";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { getWorkflowsCatalog } from "../lib/hub-api";
import { useSetPageChrome } from "../lib/page-chrome";
import { isStatusTerminal } from "../lib/run-state-adapter";
import {
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
} from "../lib/schedule-time";
import { formatRunWhen, statusLabel } from "../lib/workflow-run-status";
import { useMeSchedules } from "../hooks/use-schedules";
import { useWorkflowRuns, type WorkflowRun } from "../hooks/use-workflow";
import { ConnectedScheduleInspector } from "./workflows/ConnectedScheduleInspector";
import { ConnectedNewWorkflow } from "./workflows/ConnectedNewWorkflow";

type ScopeFilter = "all" | WorkflowScope;
type StatusFilter = "all" | "active" | "paused" | "live" | "needs_you";

function runToPhase(status: string): LiveRunPhase {
  if (status === "awaiting") return "awaiting";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "cancelled") return "cancelled";
  return "running";
}

function runToTone(status: string): WorkflowStatusTone {
  if (status === "awaiting") return "awaiting";
  if (status === "completed") return "done";
  if (status === "failed") return "fail";
  if (status === "stopped" || status === "cancelled") return "paused";
  return "running";
}

function scheduleToTone(enabled: boolean): WorkflowStatusTone {
  return enabled ? "active" : "paused";
}

function formatElapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function matchesQuery(
  q: string,
  parts: Array<string | null | undefined>,
): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return parts.some((p) => (p ?? "").toLowerCase().includes(needle));
}

function toLiveItem(
  run: WorkflowRun,
  labelFor: (kind: string) => string,
): WorkflowListItem {
  const phase = runToPhase(run.status);
  return {
    id: run.runId,
    kind: "run",
    title: labelFor(run.kind),
    subtitle: statusLabel(run.status),
    statusTone: runToTone(run.status),
    statusLabel: statusLabel(run.status),
    scope: "personal",
    meta: [
      { text: formatRunWhen(run.createdAt) },
      { text: formatElapsed(run.createdAt), mono: true },
    ],
    pulse: phase === "running" || phase === "awaiting",
  };
}

function toScheduledItem(
  schedule: ScheduledTrigger,
  labelFor: (kind: string) => string,
): WorkflowListItem {
  return {
    id: schedule.id,
    kind: "schedule",
    title: labelFor(schedule.workflowKind),
    subtitle:
      schedule.name !== schedule.workflowKind ? schedule.name : undefined,
    statusTone: scheduleToTone(schedule.enabled),
    statusLabel: schedule.enabled ? "Active" : "Paused",
    scope: schedule.scope,
    meta: [
      { text: formatRecurrence(schedule.recurrence), mono: true },
      {
        text: `Next ${formatNextFire(schedule.nextFireAt, schedule.enabled)}`,
      },
      {
        text: `Last ${formatLastFiredAt(schedule.recentFires[0]?.firedAt ?? null)}`,
      },
    ],
  };
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { workflowId: routeRunId } = useParams<{ workflowId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeTenantId } = useActiveWorkbench();

  const schedulesQuery = useMeSchedules();
  const runsQuery = useWorkflowRuns(activeTenantId);
  const catalogQuery = useQuery({
    queryKey: ["workflows-catalog", activeTenantId ?? "none"],
    queryFn: () => getWorkflowsCatalog(activeTenantId ?? undefined),
    staleTime: 5 * 60_000,
  });

  const [q, setQ] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");

  const entryByKind = useMemo(() => {
    const map = new Map<string, WorkflowCatalogEntry>();
    for (const e of catalogQuery.data?.entries ?? []) {
      map.set(e.kind, e);
    }
    return map;
  }, [catalogQuery.data]);

  const labelFor = (kind: string) =>
    entryByKind.get(kind)?.label ?? toHumanLabel(kind);

  const liveRuns = useMemo(() => {
    const runs = runsQuery.data ?? [];
    return runs.filter((r) => !isStatusTerminal(r.status));
  }, [runsQuery.data]);

  const liveItems = useMemo(
    () => liveRuns.map((r) => toLiveItem(r, labelFor)),
    // labelFor closes over entryByKind
    [liveRuns, entryByKind],
  );

  const scheduledItems = useMemo(
    () => (schedulesQuery.data ?? []).map((s) => toScheduledItem(s, labelFor)),
    [schedulesQuery.data, entryByKind],
  );

  const kindOptions = useMemo(() => {
    const kinds = new Set<string>();
    for (const r of liveRuns) kinds.add(r.kind);
    for (const s of schedulesQuery.data ?? []) kinds.add(s.workflowKind);
    return [...kinds].sort();
  }, [liveRuns, schedulesQuery.data]);

  const filteredLive = useMemo(() => {
    return liveItems.filter((item) => {
      if (scopeFilter !== "all" && item.scope !== scopeFilter) return false;
      if (statusFilter === "active" || statusFilter === "paused") return false;
      if (statusFilter === "live" && item.statusTone === "awaiting") return false;
      if (statusFilter === "needs_you" && item.statusTone !== "awaiting")
        return false;
      if (kindFilter !== "all") {
        const run = liveRuns.find((r) => r.runId === item.id);
        if (!run || run.kind !== kindFilter) return false;
      }
      return matchesQuery(q, [item.title, item.subtitle, item.statusLabel]);
    });
  }, [liveItems, liveRuns, q, scopeFilter, statusFilter, kindFilter]);

  const filteredScheduled = useMemo(() => {
    return scheduledItems.filter((item) => {
      if (scopeFilter !== "all" && item.scope !== scopeFilter) return false;
      if (statusFilter === "live" || statusFilter === "needs_you") return false;
      if (statusFilter === "active" && item.statusTone !== "active") return false;
      if (statusFilter === "paused" && item.statusTone !== "paused") return false;
      if (kindFilter !== "all") {
        const schedule = (schedulesQuery.data ?? []).find(
          (s) => s.id === item.id,
        );
        if (!schedule || schedule.workflowKind !== kindFilter) return false;
      }
      return matchesQuery(q, [item.title, item.subtitle, item.statusLabel]);
    });
  }, [
    scheduledItems,
    schedulesQuery.data,
    q,
    scopeFilter,
    statusFilter,
    kindFilter,
  ]);

  const runIdParam = routeRunId ?? searchParams.get("run") ?? null;
  const scheduleIdParam = searchParams.get("schedule");
  const isCreating = searchParams.get("new") === "1";
  const createKindParam = searchParams.get("kind");

  const selectedKind: "run" | "schedule" | null = runIdParam
    ? "run"
    : scheduleIdParam
      ? "schedule"
      : null;
  const selectedId = runIdParam ?? scheduleIdParam;

  const selectedSchedule = useMemo(() => {
    if (!scheduleIdParam) return null;
    return (
      (schedulesQuery.data ?? []).find((s) => s.id === scheduleIdParam) ?? null
    );
  }, [scheduleIdParam, schedulesQuery.data]);

  const selectItem = (item: WorkflowListItem) => {
    const next = new URLSearchParams(searchParams);
    next.delete("run");
    next.delete("schedule");
    next.delete("new");
    next.delete("kind");
    if (item.kind === "run") next.set("run", item.id);
    else next.set("schedule", item.id);
    if (routeRunId) {
      navigate({ pathname: "/workflows", search: `?${next.toString()}` });
      return;
    }
    setSearchParams(next, { replace: true });
  };

  const clearSelection = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("run");
    next.delete("schedule");
    if (routeRunId) {
      navigate({
        pathname: "/workflows",
        search: next.toString() ? `?${next}` : "",
      });
      return;
    }
    setSearchParams(next, { replace: true });
  };

  const openCreate = () => {
    setSearchParams({ new: "1" }, { replace: true });
  };

  const setCreateKind = (kind: string | null) => {
    const next = new URLSearchParams();
    next.set("new", "1");
    if (kind) next.set("kind", kind);
    setSearchParams(next, { replace: true });
  };

  const cancelCreate = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    next.delete("kind");
    setSearchParams(next, { replace: true });
  };

  const onCreated = (scheduleId: string) => {
    setSearchParams({ schedule: scheduleId }, { replace: true });
  };

  const liveCount = liveItems.length;
  const chrome = useMemo(
    () => (
      <AppPageChromeRow
        title="Workflows"
        count={
          liveCount > 0
            ? `${liveCount} live`
            : (schedulesQuery.data?.length ?? 0) > 0
              ? `${schedulesQuery.data!.length} scheduled`
              : undefined
        }
      >
        <Button
          type="button"
          size="sm"
          data-testid="new-workflow-button"
          onClick={openCreate}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New Workflow
        </Button>
      </AppPageChromeRow>
    ),
    [liveCount, schedulesQuery.data],
  );
  useSetPageChrome(chrome);

  if (isCreating) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ConnectedNewWorkflow
          catalogEntries={catalogQuery.data?.entries ?? []}
          schedules={schedulesQuery.data ?? []}
          selectedKind={createKindParam}
          onSelectKind={setCreateKind}
          onCreated={onCreated}
          onCancel={cancelCreate}
        />
      </div>
    );
  }

  const loading =
    schedulesQuery.isPending || runsQuery.isPending || catalogQuery.isPending;
  const error =
    schedulesQuery.isError || runsQuery.isError || catalogQuery.isError;

  const inspector = (() => {
    if (selectedSchedule) {
      const entry = entryByKind.get(selectedSchedule.workflowKind);
      return (
        <ConnectedScheduleInspector
          schedule={selectedSchedule}
          {...(entry ? { catalogEntry: entry } : {})}
          onRemoved={clearSelection}
          onRunStarted={(runId) => {
            const next = new URLSearchParams(searchParams);
            next.delete("schedule");
            next.delete("new");
            next.set("run", runId);
            setSearchParams(next, { replace: true });
          }}
        />
      );
    }
    if (runIdParam) {
      return (
        <div
          className="flex h-full min-h-0 flex-col"
          data-testid="live-run-inspector"
        >
          <WorkflowRunPane
            deploymentId={runIdParam}
            tenantId={activeTenantId}
            onClose={clearSelection}
            embedded
          />
        </div>
      );
    }
    return (
      <InspectorShell
        empty={
          <InspectorEmpty
            title="Select a workflow"
            description="Click a live run or schedule to review details here."
          />
        }
      />
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
            aria-hidden="true"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search workflows"
            aria-label="Search workflows"
            className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2.5 text-[13px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
          />
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Scope filter"
        >
          {(
            [
              ["all", "All scopes"],
              ["personal", "Just me"],
              ["tenant", "Everyone"],
            ] as const
          ).map(([value, label]) => (
            <FilterChip
              key={value}
              selected={scopeFilter === value}
              onClick={() => setScopeFilter(value)}
            >
              {label}
            </FilterChip>
          ))}
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Status filter"
        >
          {(
            [
              ["all", "All status"],
              ["live", "Live"],
              ["needs_you", "Needs you"],
              ["active", "Active"],
              ["paused", "Paused"],
            ] as const
          ).map(([value, label]) => (
            <FilterChip
              key={value}
              selected={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </FilterChip>
          ))}
        </div>
        {kindOptions.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Kind filter"
          >
            <FilterChip
              selected={kindFilter === "all"}
              onClick={() => setKindFilter("all")}
            >
              All kinds
            </FilterChip>
            {kindOptions.map((kind) => (
              <FilterChip
                key={kind}
                selected={kindFilter === kind}
                onClick={() => setKindFilter(kind)}
              >
                {labelFor(kind)}
              </FilterChip>
            ))}
          </div>
        ) : null}
        {selectedId ? (
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-[12px] text-text-3 underline-offset-2 hover:text-text hover:underline"
          >
            Clear selection
          </button>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <div className="min-h-0 overflow-hidden">
          {loading ? (
            <div className="px-4 py-10 text-center text-[13px] text-text-3">
              Loading workflows…
            </div>
          ) : error ? (
            <div className="px-4 py-10 text-center text-[13px] text-red">
              Could not load workflows. Try again in a moment.
            </div>
          ) : (
            <WorkflowsList
              live={filteredLive}
              scheduled={filteredScheduled}
              selectedId={selectedId}
              selectedKind={selectedKind}
              onSelect={selectItem}
              empty={
                <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
                  <p className="text-[13px] text-text-3">
                    {q ||
                    scopeFilter !== "all" ||
                    statusFilter !== "all" ||
                    kindFilter !== "all"
                      ? "No workflows match these filters."
                      : "No schedules yet. Create one to keep work running on a cadence."}
                  </p>
                  {!q &&
                  scopeFilter === "all" &&
                  statusFilter === "all" &&
                  kindFilter === "all" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={openCreate}
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      New Workflow
                    </Button>
                  ) : null}
                  <Link
                    to="/insights/runs"
                    className="text-[12px] text-text-3 underline-offset-2 hover:underline"
                  >
                    Browse run history in Insights
                  </Link>
                </div>
              }
            />
          )}
        </div>
        <div className="hidden min-h-0 overflow-hidden border-l border-border lg:block">
          {inspector}
        </div>
      </div>
    </div>
  );
}
