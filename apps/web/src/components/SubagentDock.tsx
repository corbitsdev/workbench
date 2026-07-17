import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
} from "lucide-react";
import { cn } from "@workbench/ui";
import {
  invokedSubagentDockStatus,
  useConversationInvokedSubagents,
  type ConversationInvokedSubagent,
  type InvokedSubagentDockStatus,
} from "../hooks/use-conversation-invoked-subagents";
import { useAgentPhase } from "../lib/use-agent-phase";

const ATTENTION_ORDER: Record<InvokedSubagentDockStatus, number> = {
  running: 0,
  completed: 1,
};

const STATUS_META: Record<
  InvokedSubagentDockStatus,
  { label: string; dot: string; stripe: string; chip: string }
> = {
  running: {
    label: "Running",
    dot: "bg-blue animate-pulse motion-reduce:animate-none",
    stripe: "border-l-blue",
    chip: "text-blue",
  },
  completed: {
    label: "Done",
    dot: "bg-green",
    stripe: "border-l-green",
    chip: "text-green",
  },
};

const MAX_DOCK_CARDS = 10;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

type DockVariant = "dock" | "popup";

function collapseKey(conversationId: string, variant: DockVariant): string {
  const suffix = variant === "popup" ? ":popup" : "";
  return `subagent-dock-collapsed:${conversationId}${suffix}`;
}

function readCollapsed(
  conversationId: string | null,
  variant: DockVariant,
): boolean {
  const fallback = variant === "popup";
  if (!conversationId) return fallback;
  try {
    const stored = localStorage.getItem(collapseKey(conversationId, variant));
    if (stored === "1") return true;
    if (stored === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeCollapsed(
  conversationId: string | null,
  variant: DockVariant,
  collapsed: boolean,
) {
  if (!conversationId) return;
  try {
    localStorage.setItem(
      collapseKey(conversationId, variant),
      collapsed ? "1" : "0",
    );
  } catch {
    // storage unavailable
  }
}

function stateCountSummary(
  subagents: readonly ConversationInvokedSubagent[],
): string {
  const order: InvokedSubagentDockStatus[] = ["running", "completed"];
  const parts: string[] = [];
  for (const status of order) {
    const count = subagents.filter(
      (row) => invokedSubagentDockStatus(row.sessionStatus) === status,
    ).length;
    if (count > 0) parts.push(`${count} ${status}`);
  }
  return parts.join(", ");
}

function phaseLabel(phase: ReturnType<typeof useAgentPhase>): string | null {
  if (phase === "thinking") return "Thinking…";
  if (phase === "typing") return "Typing…";
  return null;
}

function SubagentDockCard({
  row,
  tenantId,
}: {
  row: ConversationInvokedSubagent;
  tenantId?: string | null;
}) {
  const status = invokedSubagentDockStatus(row.sessionStatus);
  const meta = STATUS_META[status];
  const phaseTarget =
    tenantId !== null &&
    tenantId !== undefined &&
    tenantId !== "" &&
    status === "running"
      ? { tenantId, instanceId: row.instanceId }
      : null;
  const phase = useAgentPhase(phaseTarget);
  const live = phaseLabel(phase);

  return (
    <div
      data-testid="subagent-dock-card"
      className={cn(
        "rounded-md border border-border bg-surface-2 px-2 py-2 text-sm border-l-2",
        meta.stripe,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-text">{row.agentName}</span>
        <span className={cn("shrink-0 text-xs font-medium", meta.chip)}>
          {live ?? meta.label}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-text-3">
        {row.instanceAddress}
      </p>
    </div>
  );
}

export interface SubagentDockProps {
  conversationId: string | null;
  tenantId?: string | null;
  variant?: DockVariant;
}

/**
 * Live subagent strip beside chat (CL-3686). Hidden until the thread has had an
 * active invoked subagent; mirrors WorkflowDock collapse and poll behavior.
 */
export function SubagentDock({
  conversationId,
  tenantId,
  variant = "dock",
}: SubagentDockProps) {
  const { data: subagents } = useConversationInvokedSubagents(
    conversationId,
    tenantId,
  );
  const [collapsed, setCollapsedState] = useState(() =>
    readCollapsed(conversationId, variant),
  );
  const [sawActive, setSawActive] = useState(false);

  const sorted = useMemo(() => {
    const rows = subagents ?? [];
    return [...rows].sort((a, b) => {
      const aStatus = invokedSubagentDockStatus(a.sessionStatus);
      const bStatus = invokedSubagentDockStatus(b.sessionStatus);
      const byAttention = ATTENTION_ORDER[aStatus] - ATTENTION_ORDER[bStatus];
      if (byAttention !== 0) return byAttention;
      return b.lastInvokedAt.localeCompare(a.lastInvokedAt);
    });
  }, [subagents]);

  const hasActive = sorted.some(
    (row) => invokedSubagentDockStatus(row.sessionStatus) === "running",
  );
  useEffect(() => {
    if (hasActive) setSawActive(true);
  }, [hasActive]);
  useEffect(() => {
    setSawActive(false);
    setCollapsedState(readCollapsed(conversationId, variant));
  }, [conversationId, variant]);

  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    writeCollapsed(conversationId, variant, value);
  };

  if (sorted.length === 0 || (!hasActive && !sawActive)) return null;

  const isPopup = variant === "popup";

  if (collapsed && isPopup) {
    return (
      <aside
        aria-label="Subagent dock"
        className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5"
      >
        <button
          type="button"
          aria-label={`Expand subagents: ${stateCountSummary(sorted)}`}
          onClick={() => setCollapsed(false)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-text-2 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          <ChevronDown size={14} aria-hidden />
          Subagents
          <span className="rounded-full bg-surface-2 px-1.5 text-text-3">
            {sorted.length}
          </span>
        </button>
        <div className="flex flex-1 items-center gap-1.5">
          {sorted.map((row) => {
            const status = invokedSubagentDockStatus(row.sessionStatus);
            return (
              <span
                key={row.mappingId}
                data-testid="subagent-dock-rail-dot"
                title={`${row.agentName}: ${STATUS_META[status].label}`}
                className={cn("h-2 w-2 rounded-full", STATUS_META[status].dot)}
              >
                <span className="sr-only">
                  {`${row.agentName}: ${STATUS_META[status].label}`}
                </span>
              </span>
            );
          })}
        </div>
      </aside>
    );
  }

  if (isPopup) {
    return (
      <aside
        aria-label="Subagent dock"
        className="flex max-h-40 shrink-0 flex-col border-b border-border bg-surface"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs font-semibold text-text">Subagents</span>
          <button
            type="button"
            aria-label="Collapse subagent dock"
            onClick={() => setCollapsed(true)}
            className={cn(
              "rounded-md p-1 text-text-3 hover:bg-row-hover hover:text-text",
              FOCUS_RING,
            )}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {sorted.slice(0, MAX_DOCK_CARDS).map((row) => (
            <SubagentDockCard
              key={row.mappingId}
              row={row}
              tenantId={tenantId}
            />
          ))}
          {sorted.length > MAX_DOCK_CARDS && (
            <Link
              to="/agents"
              className={cn(
                "block rounded-md px-2 py-1.5 text-xs text-text-2 hover:bg-row-hover hover:text-text",
                FOCUS_RING,
              )}
            >
              {sorted.length - MAX_DOCK_CARDS} more — open Agents
            </Link>
          )}
        </div>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside
        aria-label="Subagent dock"
        className="flex w-80 shrink-0 items-center gap-2 border-b border-l border-border bg-surface px-2 py-2"
      >
        <button
          type="button"
          aria-label={`Expand subagents: ${stateCountSummary(sorted)}`}
          onClick={() => setCollapsed(false)}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-2 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          <ChevronsLeft size={14} aria-hidden />
          Subagents
          <span className="rounded-full bg-surface-2 px-1.5 text-text-3">
            {sorted.length}
          </span>
        </button>
        <div className="flex flex-1 items-center justify-end gap-1.5">
          {sorted.map((row) => {
            const status = invokedSubagentDockStatus(row.sessionStatus);
            return (
              <span
                key={row.mappingId}
                data-testid="subagent-dock-rail-dot"
                title={`${row.agentName}: ${STATUS_META[status].label}`}
                className={cn("h-2 w-2 rounded-full", STATUS_META[status].dot)}
              >
                <span className="sr-only">
                  {`${row.agentName}: ${STATUS_META[status].label}`}
                </span>
              </span>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Subagent dock"
      className="flex max-h-[min(40%,20rem)] w-80 shrink-0 flex-col border-b border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-text">Subagents</span>
        <button
          type="button"
          aria-label="Collapse subagent dock"
          onClick={() => setCollapsed(true)}
          className={cn(
            "rounded-md p-1 text-text-3 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          <ChevronsRight size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {sorted.slice(0, MAX_DOCK_CARDS).map((row) => (
          <SubagentDockCard key={row.mappingId} row={row} tenantId={tenantId} />
        ))}
        {sorted.length > MAX_DOCK_CARDS && (
          <Link
            to="/agents"
            className={cn(
              "block rounded-md px-2 py-1.5 text-xs text-text-2 hover:bg-row-hover hover:text-text",
              FOCUS_RING,
            )}
          >
            {sorted.length - MAX_DOCK_CARDS} more — open Agents
          </Link>
        )}
      </div>
    </aside>
  );
}
