import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RosterInstance } from "@workbench/client";

import type { ActivityOverview } from "../../lib/hub-api";
import { useTenantRoster } from "../../hooks/use-tenant-roster";
import { actorHref } from "./ActorActivity";
import { sumInferenceTokenClasses } from "./metrics";
import { formatNumber } from "./stats";
import { SectionLabel } from "./section-label";
import { instanceStatusTone, statusToneClass } from "./status-tone";

const AGENT_GROUP_PAGE_SIZE = 10;

type InstanceMetrics = {
  turnCount: number;
  toolCallCount: number;
  tokens: number;
};

type AgentGroup = {
  agentId: string;
  agentName: string;
  instances: RosterInstance[];
};

/**
 * Groups every agent instance in the tenant by its agent definition (CL-3667):
 * one row per agent, instances expandable beneath it. Replaces the two prior
 * flat agent surfaces (TenantRoster's "Agents" panel and the by-instance usage
 * table), which duplicated the same data and rendered raw prn_/ins_ ids.
 */
function groupByAgent(instances: RosterInstance[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const instance of instances) {
    const existing = groups.get(instance.agentId);
    if (existing) {
      existing.instances.push(instance);
    } else {
      groups.set(instance.agentId, {
        agentId: instance.agentId,
        agentName: instance.name,
        instances: [instance],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.instances.length - a.instances.length,
  );
}

function AgentInstanceRow({
  instance,
  metrics,
}: {
  instance: RosterInstance;
  metrics: InstanceMetrics | undefined;
}) {
  return (
    <Link
      to={actorHref(instance.principalId)}
      className="flex items-center gap-3 rounded-[8px] px-3 py-2 outline-none transition-[background-color] hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent"
      data-testid="agent-instance-row"
    >
      <span
        className={`inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.05em] ${statusToneClass(instanceStatusTone(instance.status))}`}
      >
        {instance.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">
        {instance.sessionCount === 1
          ? "1 session"
          : `${instance.sessionCount} sessions`}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.turnCount)} turns` : "no usage"}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.toolCallCount)} tools` : ""}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.tokens)} tok` : ""}
      </span>
    </Link>
  );
}

function AgentGroupCard({
  group,
  metricsByInstance,
}: {
  group: AgentGroup;
  metricsByInstance: Map<string, InstanceMetrics>;
}) {
  const [expanded, setExpanded] = useState(false);
  const groupTurns = group.instances.reduce(
    (sum, i) => sum + (metricsByInstance.get(i.instanceId)?.turnCount ?? 0),
    0,
  );

  return (
    <div className="rounded-[12px] border border-border bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        data-testid="agent-group-toggle"
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-text-3" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-text-3" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-text">
            {group.agentName}
          </span>
          <span className="block text-[11px] text-text-3">
            {group.instances.length === 1
              ? "1 instance"
              : `${group.instances.length} instances`}
          </span>
        </span>
        <span className="font-mono tabular-nums text-[11px] text-text-3">
          {formatNumber(groupTurns)} turns
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-0.5 border-t border-border px-2 pb-2 pt-1">
          {group.instances.map((instance) => (
            <AgentInstanceRow
              key={instance.instanceId}
              instance={instance}
              metrics={metricsByInstance.get(instance.instanceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentsSection({
  tenantId,
  data,
}: {
  tenantId: string;
  data: ActivityOverview;
}) {
  const [visibleCount, setVisibleCount] = useState(AGENT_GROUP_PAGE_SIZE);
  const query = useTenantRoster(tenantId, { enabled: tenantId !== "" });
  const roster = query.data;

  const metricsByInstance = new Map<string, InstanceMetrics>(
    data.inference.byInstance.map((row) => [
      row.instanceId,
      {
        turnCount: row.turnCount,
        toolCallCount: row.toolCallCount,
        tokens: sumInferenceTokenClasses(row),
      },
    ]),
  );

  const groups = groupByAgent(roster?.instances ?? []);
  const visible = groups.slice(0, visibleCount);
  const remaining = groups.length - visible.length;

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Agents</SectionLabel>
      <p className="-mt-2 text-[11px] text-text-3">
        Grouped by agent definition. Open an agent to see its instances.
      </p>

      {query.isError && (
        <div className="flex flex-col items-start gap-2 rounded border border-border bg-surface p-4">
          <span className="text-[13px] text-text-2">
            Couldn&rsquo;t load agents. Please try again.
          </span>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="flex min-h-[40px] items-center rounded-sm border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[color,background-color] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Retry
          </button>
        </div>
      )}

      {!query.isError && query.isLoading && (
        <div className="flex flex-col gap-2" data-testid="agents-loading">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-[12px] bg-surface-2"
            />
          ))}
        </div>
      )}

      {!query.isError && !query.isLoading && groups.length === 0 && (
        <p className="rounded-[12px] border border-border bg-surface p-4 text-center text-[12.5px] text-text-2">
          No agent instances in this workbench yet.
        </p>
      )}

      {!query.isError && !query.isLoading && groups.length > 0 && (
        <div className="flex flex-col gap-2">
          {visible.map((group) => (
            <AgentGroupCard
              key={group.agentId}
              group={group}
              metricsByInstance={metricsByInstance}
            />
          ))}
        </div>
      )}

      {remaining > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-3">
            Showing {formatNumber(visible.length)} of{" "}
            {formatNumber(groups.length)} agents
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((count) => count + AGENT_GROUP_PAGE_SIZE)
            }
            className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Show {Math.min(remaining, AGENT_GROUP_PAGE_SIZE)} more
          </button>
        </div>
      )}
    </div>
  );
}
