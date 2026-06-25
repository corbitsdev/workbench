import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { resolveKindLabel } from "../../lib/resolve-kind-label";
import { toHumanLabel } from "@workbench/ui";
import type { WorkflowRun } from "../../hooks/use-workflow";
import {
  listAgentInstances,
  listWorkbenches,
  stopAgentInstance,
  launchInstanceSession,
} from "../../lib/hub-api";
import type {
  AgentInstance,
  WorkbenchEntry,
  CredentialRequirement,
} from "../../lib/hub-api";
import { useAgentPhase } from "../../lib/use-agent-phase";
import type { AgentPhase } from "@workbench/agents/browser";
import { useWorkflowRuns } from "../../hooks/use-workflow";
import { useState } from "react";

type ResourceType = "workflow" | "agent";
type ResourceStatus = "run" | "done" | "idle";
type RailGroup = "Agents" | "Workflows";

interface RailItemBase {
  id: string;
  group: RailGroup;
  name: string;
  sub: string;
  status: ResourceStatus;
  who: string;
  color: string;
}

interface AgentRailItem extends RailItemBase {
  type: "agent";
  instanceId?: string;
  tenantId?: string;
  agentId?: string;
  agentStatus?: string;
  credentialRequirements?: CredentialRequirement[];
  capabilities?: Record<string, unknown> | null;
}

interface WorkflowRailItem extends RailItemBase {
  type: "workflow";
  workflowStatus: string;
  workflowKind: string;
}

type RailItem = AgentRailItem | WorkflowRailItem;

function agentStatusLabel(status: string): string {
  if (status === "running") return "Running";
  if (status === "stopped") return "Stopped";
  return "Deploying";
}

// "Reasoning" (not "Thinking") mirrors the chat reasoning disclosure and avoids
// anthropomorphizing the agent per the brand word list.
const AGENT_PHASE_LABEL: Record<AgentPhase, string> = {
  idle: "Idle",
  thinking: "Reasoning",
  typing: "Typing",
};

function agentToRailItem(a: AgentInstance): AgentRailItem {
  return {
    id: a.id,
    group: "Agents",
    name: a.agentName,
    type: "agent",
    sub: `Agent · ${agentStatusLabel(a.status)}`,
    status: a.status === "running" ? "run" : "idle",
    who: a.agentName.slice(0, 2).toUpperCase(),
    color: a.status === "stopped" ? "var(--text-3)" : "var(--green)",
    instanceId: a.id,
    tenantId: a.tenantId,
    agentId: a.agentId,
    agentStatus: a.status,
    credentialRequirements: a.credentialRequirements,
    capabilities: a.capabilities,
  };
}

interface WorkbenchesAndAgents {
  workbenches: WorkbenchEntry[];
  agentItems: AgentRailItem[];
  agentLoadError: boolean;
}

async function fetchWorkbenchesAndAgents(): Promise<WorkbenchesAndAgents> {
  const entries = await listWorkbenches();
  const agentResults = await Promise.allSettled(
    entries.map((w) => listAgentInstances(w.tenantId)),
  );
  const loadedAgents = agentResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  return {
    workbenches: entries,
    agentItems: loadedAgents.map(agentToRailItem),
    agentLoadError: agentResults.some((result) => result.status === "rejected"),
  };
}

function useWorkbenchesAndAgents(externalTick = 0): {
  workbenches: WorkbenchEntry[];
  agentItems: AgentRailItem[];
  isLoading: boolean;
  error: boolean;
  agentLoadError: boolean;
  retry: () => void;
} {
  const query = useQuery<WorkbenchesAndAgents>({
    queryKey: ["workbenches-and-agents", externalTick],
    queryFn: fetchWorkbenchesAndAgents,
    staleTime: 60 * 1000,
  });

  return {
    workbenches: query.data?.workbenches ?? [],
    agentItems: query.data?.agentItems ?? [],
    isLoading: query.isLoading,
    error: query.isError,
    agentLoadError: query.data?.agentLoadError ?? false,
    retry: () => void query.refetch(),
  };
}

// Statuses the hub sets as terminal — these move a run into the Done section.
const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "cancelled"]);

const SESSION_STATUS_TO_RAIL: Record<string, ResourceStatus> = {
  pending: "idle",
  running: "run",
  analyzing: "run",
  ready: "run",
  reviewing: "run",
  generating: "run",
  done: "done",
  completed: "done",
  failed: "done",
  cancelled: "done",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  analyzing: "Analyzing",
  ready: "Ready",
  generating: "Generating",
  reviewing: "Reviewing",
  done: "Done",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function workflowKindLabel(kind: string): string {
  return resolveKindLabel(kind) ?? kind;
}

function workflowToRailItem(w: WorkflowRun): WorkflowRailItem {
  const statusLabel = STATUS_LABELS[w.status] ?? toHumanLabel(w.status);
  const started = new Date(w.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const sub = `${statusLabel} · ${started}`;
  return {
    id: w.runId,
    group: "Workflows",
    name: workflowKindLabel(w.kind),
    type: "workflow",
    sub,
    status: SESSION_STATUS_TO_RAIL[w.status] ?? "idle",
    who: "GA",
    color: "var(--accent)",
    workflowStatus: w.status,
    workflowKind: w.kind,
  };
}

const GROUP_ORDER: RailGroup[] = ["Agents", "Workflows"];

const TAG_STYLES: Record<ResourceType, string> = {
  workflow: "bg-[rgba(233,132,40,0.16)] text-orange",
  agent: "bg-[rgba(123,153,116,0.18)] text-green",
};

const DOT_STYLES: Record<ResourceType, string> = {
  workflow: "bg-orange",
  agent: "bg-green",
};

function StatusDot({
  status,
  pulse = false,
}: {
  status: ResourceStatus;
  pulse?: boolean;
}) {
  if (status === "run" && pulse) {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-orange">
        <span className="absolute inset-[2px] animate-pulse rounded-full bg-orange" />
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full bg-green">
        <span className="absolute left-[4px] top-[1.5px] h-2 w-1 rotate-[42deg] border-b-2 border-r-2 border-white" />
      </span>
    );
  }
  if (status === "run") {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-orange">
        <span className="absolute inset-[2px] rounded-full bg-orange" />
      </span>
    );
  }
  return (
    <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-text-3">
      <span className="absolute inset-[3px] rounded-full bg-text-3 opacity-40" />
    </span>
  );
}

// The status dot + name + subtitle for one rail row. Rendered as its own
// component so each agent row owns its phase subscription independently — an
// agent entering or leaving the list mounts/unmounts only its own row, never
// disturbing the others' live connections.
function RailItemLead({
  item,
  isRestarting,
}: {
  item: RailItem;
  isRestarting: boolean;
}) {
  const phaseTarget =
    item.type === "agent" &&
    item.agentStatus === "running" &&
    item.instanceId !== undefined &&
    item.tenantId !== undefined
      ? { instanceId: item.instanceId, tenantId: item.tenantId }
      : null;
  const phase = useAgentPhase(phaseTarget);
  const isActivePhase = phase === "thinking" || phase === "typing";

  let sub = item.sub;
  if (item.type === "agent" && isRestarting) {
    sub = "Agent · Creating…";
  } else if (phase !== null) {
    sub = `Agent · ${AGENT_PHASE_LABEL[phase]}`;
  }

  return (
    <>
      <StatusDot status={item.status} pulse={isActivePhase} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-text">
          {item.name}
        </div>
        <div className="mt-px font-mono text-[11.5px] text-text-3">{sub}</div>
      </div>
    </>
  );
}

function workflowStatusBadgeClass(workflowStatus: string): string {
  if (workflowStatus === "completed" || workflowStatus === "done") {
    return "bg-[rgba(123,153,116,0.18)] text-green";
  }
  if (workflowStatus === "failed" || workflowStatus === "cancelled") {
    return "bg-[rgba(125,116,104,0.18)] text-text-3";
  }
  // Active statuses
  return "bg-[rgba(233,132,40,0.16)] text-orange";
}

function workflowStatusDotClass(workflowStatus: string): string {
  if (workflowStatus === "completed" || workflowStatus === "done") {
    return "bg-green";
  }
  if (workflowStatus === "failed" || workflowStatus === "cancelled") {
    return "bg-text-3";
  }
  return "bg-orange";
}

// Pure presentational row for a terminal-status workflow. Owns no data loading
// or state — the container passes the item, the active flag, and the callbacks.
export function CompletedWorkflowRow({
  item,
  isActive,
  onOpen,
}: {
  item: WorkflowRailItem;
  isActive: boolean;
  onOpen?: () => void;
}) {
  const statusLabel =
    STATUS_LABELS[item.workflowStatus] ?? toHumanLabel(item.workflowStatus);
  return (
    <div
      className={`group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors ${onOpen ? "hover:bg-[var(--row-hover)]" : ""} ${isActive ? "bg-surface ring-1 ring-orange/60" : ""}`}
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={`Open workflow ${item.name}`}
          onClick={onOpen}
          className="absolute inset-0 z-0 cursor-pointer rounded-[12px]"
        />
      ) : null}
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-[11px]">
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-text">
            {item.name}
          </div>
          <div className="mt-px font-mono text-[11.5px] text-text-3">
            {item.sub}
          </div>
        </div>
      </div>
      <div className="relative z-[1] flex flex-none items-center gap-[11px]">
        <span
          className={`flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.03em] ${workflowStatusBadgeClass(item.workflowStatus)}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${workflowStatusDotClass(item.workflowStatus)}`}
          />
          {statusLabel}
        </span>
        <div
          className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[10px] font-bold text-white"
          style={{ background: "var(--accent)" }}
        >
          GA
        </div>
      </div>
    </div>
  );
}

export interface AgentSelection {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

export interface LibraryRailProps {
  onClose?: () => void;
  onNew?: () => void;
  onAgentSelect?: (selection: AgentSelection) => void;
  onWorkflowSelect?: (workflowId: string, workflowKind: string) => void;
  onWorkbenchSelect?: (slug: string) => void;
  onAgentDeleted?: () => void;
  activeAgentInstanceId?: string;
  activeWorkflowId?: string;
  activeWorkbenchSlug?: string;
  refreshTick?: number;
}

const SEGMENT_FILTER: Record<string, ResourceType | null> = {
  All: null,
  Agents: "agent",
  Workflows: "workflow",
};

export function LibraryRail({
  onClose,
  onNew,
  onAgentSelect,
  onWorkflowSelect,
  onWorkbenchSelect,
  onAgentDeleted,
  activeAgentInstanceId,
  activeWorkflowId,
  activeWorkbenchSlug,
  refreshTick,
}: LibraryRailProps = {}) {
  const {
    workbenches,
    agentItems: allAgentItems,
    error: workbenchError,
    agentLoadError,
    retry: retryWorkbenches,
  } = useWorkbenchesAndAgents(refreshTick);

  const [activeSegment, setActiveSegment] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [stoppingInstanceId, setStoppingInstanceId] = useState<string | null>(
    null,
  );
  const [restartingInstanceId, setRestartingInstanceId] = useState<
    string | null
  >(null);
  const [completedWorkflowsOpen, setCompletedWorkflowsOpen] = useState(false);

  // Resolve the tenantId for the active workbench so agents can be scoped.
  const activeWorkbench = workbenches.find(
    (w) => w.tenantSlug === activeWorkbenchSlug,
  );
  const activeWorkbenchTenantId = activeWorkbench?.tenantId;

  const {
    data: workflows,
    isLoading: jobsLoading,
    isError,
  } = useWorkflowRuns(
    activeWorkbenchSlug ? (activeWorkbenchTenantId ?? null) : undefined,
  );

  // Scope agents to the active workbench; fall back to all agents when no slug is set.
  const agentItems = activeWorkbenchTenantId
    ? allAgentItems.filter((a) => a.tenantId === activeWorkbenchTenantId)
    : allAgentItems;

  const allJobItems = (workflows ?? []).map(workflowToRailItem);
  const jobItems = allJobItems.filter(
    (w) => !TERMINAL_STATUSES.has(w.workflowStatus),
  );
  const completedJobItems = allJobItems.filter((w) =>
    TERMINAL_STATUSES.has(w.workflowStatus),
  );
  const items: RailItem[] = [...agentItems, ...jobItems];
  const isLoading = jobsLoading;

  const segments: { label: string; count: number }[] = [
    { label: "All", count: agentItems.length + jobItems.length },
    { label: "Agents", count: agentItems.length },
    { label: "Workflows", count: jobItems.length },
  ];

  const typeFilter = SEGMENT_FILTER[activeSegment] ?? null;
  const query = searchQuery.trim().toLowerCase();

  const visibleItems = items.filter((item) => {
    if (typeFilter !== null && item.type !== typeFilter) return false;
    if (
      query !== "" &&
      !item.name.toLowerCase().includes(query) &&
      !item.sub.toLowerCase().includes(query)
    )
      return false;
    return true;
  });

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      {/* Workbench switcher — hidden when user has no workbenches */}
      {workbenches.length > 0 && (
        <div className="border-b border-border px-[18px] pb-[12px] pt-[16px]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[6px]">
              {workbenches.map((wb) => {
                const isActive = wb.tenantSlug === activeWorkbenchSlug;
                return (
                  <button
                    key={wb.id}
                    type="button"
                    onClick={() => onWorkbenchSelect?.(wb.tenantSlug)}
                    className={`rounded-[8px] border px-2.5 py-[5px] text-[12px] font-semibold transition-colors ${
                      isActive
                        ? "border-orange bg-[rgba(233,132,40,0.12)] text-orange"
                        : "border-border text-text-2 hover:border-orange/60 hover:text-text"
                    }`}
                  >
                    {wb.tenantName}
                  </button>
                );
              })}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close workbench"
                className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-[18px] w-[18px]"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="mt-3 flex items-center gap-[9px] rounded-[12px] border border-border bg-surface px-[11px] py-2 focus-within:border-orange">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-[15px] w-[15px] flex-none text-text-3"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" />
            </svg>
            <input
              aria-label="Search workflows, agents"
              placeholder="Search workflows, agents…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full border-none bg-transparent text-[14px] text-text outline-none placeholder:text-text-3"
            />
            {searchQuery === "" && (
              <span className="flex-none rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-3">
                ⌘K
              </span>
            )}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-[3px] px-4 pb-1.5 pt-3">
        {segments.map((seg) => (
          <button
            key={seg.label}
            type="button"
            onClick={() => setActiveSegment(seg.label)}
            className={`flex items-center gap-[5px] whitespace-nowrap rounded-[9px] px-[9px] py-1.5 text-[12px] font-semibold transition-colors ${
              activeSegment === seg.label
                ? "bg-surface text-text shadow-[0_2px_6px_rgba(0,0,0,0.2)]"
                : "text-text-2 hover:bg-[var(--row-hover)]"
            }`}
          >
            {seg.label}{" "}
            <span className="font-mono text-[10.5px] text-text-3">
              {seg.count}
            </span>
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-[10px] pb-[22px] pt-1">
        {isLoading && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">
            Loading workbench…
          </div>
        )}
        {isError && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">
            Could not load workflows.
          </div>
        )}
        {workbenchError && (
          <div className="flex flex-col gap-2 px-[10px] py-6">
            <p className="text-[13px] text-text-3">
              Could not load workbenches.
            </p>
            <button
              type="button"
              onClick={retryWorkbenches}
              className="self-start rounded-[9px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
            >
              Retry
            </button>
          </div>
        )}
        {agentLoadError && !workbenchError && (
          <div className="px-[10px] py-3 text-[13px] text-text-3">
            Some agents could not be loaded.
          </div>
        )}
        {GROUP_ORDER.map((group) => {
          const inGroup = visibleItems.filter((i) => i.group === group);
          // Always render the Agents group header when onNew is provided so the
          // deploy button is accessible even before any agents exist. Do the same
          // for Jobs when onNewWorkflow is provided.
          const showGroup =
            inGroup.length > 0 || (group === "Agents" && onNew !== undefined);
          if (!showGroup) return null;

          return (
            <div key={group}>
              <div className="flex items-center gap-2 px-[10px] pb-[7px] pt-[14px] text-[11.5px] font-bold uppercase tracking-[0.05em] text-text-3">
                {group}
                <span className="font-mono text-[11px] font-normal opacity-70">
                  {inGroup.length}
                </span>
                <span className="h-px flex-1 bg-border" />
                {group === "Agents" && onNew && (
                  <button
                    type="button"
                    onClick={onNew}
                    aria-label="Add agent"
                    className="-m-[11px] grid h-[40px] w-[40px] flex-none place-items-center rounded-[5px] text-text-3 transition-colors hover:text-orange"
                  >
                    <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-border transition-colors hover:border-orange">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="h-[11px] w-[11px]"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </button>
                )}
              </div>
              {inGroup.map((item) => {
                const isClickableAgent =
                  item.type === "agent" &&
                  item.agentStatus !== "stopped" &&
                  onAgentSelect !== undefined &&
                  item.instanceId !== undefined &&
                  item.tenantId !== undefined;
                const isClickableWorkflow =
                  item.type === "workflow" && onWorkflowSelect !== undefined;
                const isClickable = isClickableAgent || isClickableWorkflow;
                const isActiveAgent =
                  item.type === "agent" &&
                  item.instanceId === activeAgentInstanceId;
                const isActiveWorkflow =
                  item.type === "workflow" && item.id === activeWorkflowId;
                const isRestarting =
                  item.type === "agent" &&
                  restartingInstanceId === item.instanceId;

                const openItem = () => {
                  if (
                    item.type === "agent" &&
                    isClickableAgent &&
                    onAgentSelect &&
                    item.instanceId &&
                    item.tenantId
                  ) {
                    onAgentSelect({
                      instanceId: item.instanceId,
                      tenantId: item.tenantId,
                      agentName: item.name,
                    });
                  } else if (item.type === "workflow" && onWorkflowSelect) {
                    onWorkflowSelect(item.id, item.workflowKind);
                  }
                };

                const stopAgent = async () => {
                  if (item.type !== "agent") return;
                  if (!item.instanceId || !item.tenantId) return;
                  setStoppingInstanceId(item.instanceId);
                  try {
                    await stopAgentInstance(item.tenantId, item.instanceId);
                    onAgentDeleted?.();
                  } finally {
                    setStoppingInstanceId(null);
                  }
                };

                const restartAgent = async () => {
                  if (item.type !== "agent" || !item.instanceId) return;
                  setRestartingInstanceId(item.instanceId);
                  try {
                    await launchInstanceSession(item.instanceId);
                    onAgentDeleted?.();
                  } finally {
                    setRestartingInstanceId(null);
                  }
                };

                const rowLabel =
                  item.type === "workflow"
                    ? `Open workflow ${item.name}`
                    : `Open agent ${item.name}`;

                const workflowBadgeClass =
                  item.type === "workflow"
                    ? workflowStatusBadgeClass(item.workflowStatus)
                    : TAG_STYLES[item.type];
                const workflowDotClass =
                  item.type === "workflow"
                    ? workflowStatusDotClass(item.workflowStatus)
                    : DOT_STYLES[item.type];
                const badgeLabel =
                  item.type === "workflow"
                    ? (STATUS_LABELS[item.workflowStatus] ??
                      toHumanLabel(item.workflowStatus))
                    : item.type;

                return (
                  <div
                    key={item.id}
                    className={`group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors ${isClickable ? "hover:bg-[var(--row-hover)]" : ""} ${isActiveAgent || isActiveWorkflow ? "bg-surface ring-1 ring-orange/60" : ""}`}
                  >
                    {isClickable ? (
                      <button
                        type="button"
                        aria-label={rowLabel}
                        onClick={openItem}
                        className="absolute inset-0 z-0 cursor-pointer rounded-[12px]"
                      />
                    ) : null}
                    <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-[11px]">
                      <RailItemLead item={item} isRestarting={isRestarting} />
                    </div>
                    <div className="relative z-[1] flex flex-none items-center gap-[11px]">
                      {item.type === "agent" &&
                        item.agentId &&
                        item.tenantId && (
                          <div className="flex flex-none gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {item.agentStatus === "stopped" ? (
                              <>
                                <button
                                  type="button"
                                  aria-label="Create Agent"
                                  disabled={
                                    restartingInstanceId === item.instanceId
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void restartAgent();
                                  }}
                                  className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-text disabled:opacity-50"
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="h-[13px] w-[13px]"
                                  >
                                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                    <path d="M3 3v5h5" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  aria-label="Remove Agent"
                                  disabled={
                                    stoppingInstanceId === item.instanceId
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(`Remove ${item.name}?`))
                                      void stopAgent();
                                  }}
                                  className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-orange-deep disabled:opacity-50"
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="h-[13px] w-[13px]"
                                  >
                                    <rect
                                      x="3"
                                      y="3"
                                      width="18"
                                      height="18"
                                      rx="2"
                                    />
                                  </svg>
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  aria-label="Remove Agent"
                                  disabled={
                                    stoppingInstanceId === item.instanceId
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(`Remove ${item.name}?`))
                                      void stopAgent();
                                  }}
                                  className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-orange-deep disabled:opacity-50"
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="h-[13px] w-[13px]"
                                  >
                                    <rect
                                      x="3"
                                      y="3"
                                      width="18"
                                      height="18"
                                      rx="2"
                                    />
                                  </svg>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      <span
                        className={`flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.03em] ${workflowBadgeClass}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${workflowDotClass}`}
                        />
                        {badgeLabel}
                      </span>
                      <div
                        className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[10px] font-bold text-white"
                        style={{ background: item.color }}
                      >
                        {item.who}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Completed Workflows — collapsible, hidden by default */}
        {completedJobItems.length > 0 &&
          (typeFilter === null || typeFilter === "workflow") &&
          query === "" && (
            <div>
              <button
                type="button"
                onClick={() => setCompletedWorkflowsOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-[10px] pb-[7px] pt-[14px] text-[11.5px] font-bold uppercase tracking-[0.05em] text-text-3 hover:text-text-2 transition-colors"
              >
                {completedWorkflowsOpen ? (
                  <ChevronDown className="h-3 w-3 flex-none" />
                ) : (
                  <ChevronRight className="h-3 w-3 flex-none" />
                )}
                Completed
                <span className="font-mono text-[11px] font-normal opacity-70">
                  {completedJobItems.length}
                </span>
                <span className="h-px flex-1 bg-border" />
              </button>
              {completedWorkflowsOpen &&
                completedJobItems.map((item) => {
                  const isActive = item.id === activeWorkflowId;

                  return (
                    <CompletedWorkflowRow
                      key={item.id}
                      item={item}
                      isActive={isActive}
                      onOpen={
                        onWorkflowSelect
                          ? () => onWorkflowSelect(item.id, item.workflowKind)
                          : undefined
                      }
                    />
                  );
                })}
            </div>
          )}
      </div>
    </aside>
  );
}
