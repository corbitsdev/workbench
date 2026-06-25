import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart2 } from "lucide-react";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { describeHubApiFailure, getActivityOverview } from "../lib/hub-api";
import type {
  ActivityOverview,
  AnalyticsAgentRow,
  AnalyticsSummary,
} from "../lib/hub-api";

type Preset = "7d" | "30d" | "90d" | "all";

const PRESETS: { label: string; value: Preset }[] = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "all" },
];

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function presetToDates(preset: Preset): {
  startDate?: string;
  endDate?: string;
} {
  if (preset === "all") return {};
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return { startDate: daysAgoISO(days) };
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function KPICard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[12px] border border-border bg-surface p-4">
      <span className="text-[12px] font-medium text-text-3">{label}</span>
      <span
        className={`text-[24px] font-bold ${accent ? "text-orange" : "text-text"}`}
      >
        {value}
      </span>
      {sub && <span className="text-[12px] text-text-3">{sub}</span>}
    </div>
  );
}

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[13px] text-text-2">{label}</span>
      <span className="text-[13px] font-medium text-text">
        {formatNumber(value)}
      </span>
    </div>
  );
}

function SummaryContent({ data }: { data: AnalyticsSummary }) {
  const totalTokens =
    data.inputTokens +
    data.outputTokens +
    data.cacheReadTokens +
    data.cacheWriteTokens +
    data.thinkingTokens;

  const allZero =
    data.turnCount === 0 && data.toolCallCount === 0 && totalTokens === 0;

  if (allZero) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <span className="text-[14px] text-text-2">No activity yet</span>
        <span className="text-[13px] text-text-3">
          Usage data will appear here once your workbench has activity.
        </span>
      </div>
    );
  }

  const successfulTurnCount = data.turnCount - data.failedTurnCount;
  const successRate =
    data.turnCount > 0
      ? `${((successfulTurnCount / data.turnCount) * 100).toFixed(1)}% success rate`
      : undefined;

  const successfulToolCallCount = data.toolCallCount - data.toolErrorCount;
  const toolSuccessRate =
    data.toolCallCount > 0
      ? `${((successfulToolCallCount / data.toolCallCount) * 100).toFixed(1)}% success rate`
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KPICard label="Total turns" value={formatNumber(data.turnCount)} />
        <KPICard
          label="Successful turns"
          value={formatNumber(successfulTurnCount)}
          sub={successRate}
          accent={data.failedTurnCount > 0}
        />
        <KPICard label="Tool calls" value={formatNumber(data.toolCallCount)} />
        <KPICard
          label="Successful tool calls"
          value={formatNumber(successfulToolCallCount)}
          sub={toolSuccessRate}
          accent={data.toolErrorCount > 0}
        />
      </div>

      <div className="rounded-[12px] border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-semibold text-text">
            Token usage
          </span>
          <span className="text-[13px] font-bold text-text">
            {formatNumber(totalTokens)} total
          </span>
        </div>
        <div className="divide-y divide-border">
          <TokenRow label="Input" value={data.inputTokens} />
          <TokenRow label="Output" value={data.outputTokens} />
          <TokenRow label="Cache read" value={data.cacheReadTokens} />
          <TokenRow label="Cache write" value={data.cacheWriteTokens} />
          <TokenRow label="Thinking" value={data.thinkingTokens} />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="h-[92px] animate-pulse rounded-[12px] border border-border bg-surface" />
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

function CountTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; count: number }[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[12px] border border-border bg-surface p-4">
        <h3 className="mb-2 text-[13px] font-semibold text-text">{title}</h3>
        <p className="text-[13px] text-text-3">None recorded</p>
      </div>
    );
  }

  return (
    <div className="rounded-[12px] border border-border bg-surface p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-text">{title}</h3>
      <table className="w-full text-left text-[13px]">
        <thead className="text-[12px] text-text-3">
          <tr>
            <th className="pb-2 font-medium">Key</th>
            <th className="pb-2 text-right font-medium">Count</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="py-1.5 text-text-2">{row.key}</td>
              <td className="py-1.5 text-right font-medium text-text">
                {formatNumber(row.count)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OperationalLedger({ data }: { data: ActivityOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[14px] font-semibold text-text">
        Operational ledger
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KPICard
          label="Artifacts (total)"
          value={formatNumber(data.artifacts.total)}
        />
        <KPICard
          label="Artifacts (in range)"
          value={formatNumber(data.artifacts.createdInRange)}
        />
        <KPICard
          label="Workflow executions"
          value={formatNumber(data.workflowRuns.executionRecords)}
        />
        <KPICard
          label="Active workflow runs"
          value={formatNumber(data.workflowRuns.activeExecutions)}
        />
        <KPICard
          label="Agent instances (active)"
          value={formatNumber(data.agentInstances.active)}
        />
        <KPICard
          label="Agent instances (total)"
          value={formatNumber(data.agentInstances.total)}
        />
        <KPICard
          label="Instances started (range)"
          value={formatNumber(data.agentInstances.startedInRange)}
        />
        <KPICard
          label="Deployments indexed"
          value={formatNumber(data.workflowRuns.deploymentsIndexed)}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CountTable
          title="Artifacts by status"
          rows={data.artifacts.byStatus}
        />
        <CountTable title="Artifacts by kind" rows={data.artifacts.byKind} />
        <CountTable
          title="Workflow runs by status"
          rows={data.workflowRuns.byStatus}
        />
        <CountTable
          title="Workflow runs by kind"
          rows={data.workflowRuns.byKind}
        />
      </div>
    </div>
  );
}

function AgentBreakdown({ agents }: { agents: AnalyticsAgentRow[] }) {
  if (agents.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">By agent</h2>
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[480px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[12px] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium text-right">Turns</th>
              <th className="px-4 py-2 font-medium text-right">Tool calls</th>
              <th className="px-4 py-2 font-medium text-right">
                Tokens (in+out)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {agents.map((row) => (
              <tr key={row.agentId}>
                <td className="px-4 py-2 text-text">
                  {row.agentName ?? row.agentId}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.turnCount)}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.toolCallCount)}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.inputTokens + row.outputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InstanceBreakdown({
  instances,
}: {
  instances: ActivityOverview["inference"]["byInstance"];
}) {
  if (instances.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">By agent instance</h2>
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[12px] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Instance</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium text-right">Turns</th>
              <th className="px-4 py-2 font-medium text-right">Tool calls</th>
              <th className="px-4 py-2 font-medium text-right">
                Tokens (in+out)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {instances.map((row) => (
              <tr key={row.instanceId}>
                <td className="px-4 py-2 font-mono text-[12px] text-text-2">
                  {row.instanceId}
                </td>
                <td className="px-4 py-2 text-text">
                  {row.agentName ?? row.agentId}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.turnCount)}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.toolCallCount)}
                </td>
                <td className="px-4 py-2 text-right text-text-2">
                  {formatNumber(row.inputTokens + row.outputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InsightsDashboard() {
  const [preset, setPreset] = useState<Preset>("30d");
  const { activeTenantId, activeWorkbench, loading } = useActiveWorkbench();

  const dates = presetToDates(preset);

  const overviewQuery = useQuery({
    queryKey: ["activity-overview", activeTenantId, preset],
    queryFn: () => getActivityOverview(activeTenantId!, dates),
    enabled: !!activeTenantId,
    staleTime: 5 * 60_000,
  });

  const showSummaryLoading =
    loading || (!!activeTenantId && overviewQuery.isLoading);

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <div className="flex flex-1 flex-col overflow-hidden rounded-panel border border-border bg-bg">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 shrink-0 text-text-3" />
              <p className="text-[14px] font-semibold text-text">
                Data &amp; Insights
              </p>
            </div>
            {activeWorkbench && (
              <p className="truncate pl-6 text-[12px] text-text-3">
                {activeWorkbench.tenantName}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPreset(p.value)}
                  className={`rounded-[8px] px-3 py-1 text-[12px] font-medium transition-colors ${
                    preset === p.value
                      ? "bg-orange/10 text-orange"
                      : "text-text-3 hover:bg-[var(--row-hover)] hover:text-text"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {showSummaryLoading && <SkeletonGrid />}

          {!loading && !activeTenantId && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              Select a workbench to view analytics.
            </div>
          )}

          {overviewQuery.isError && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              {describeHubApiFailure(overviewQuery.error)}
            </div>
          )}

          {overviewQuery.data && (
            <div className="flex flex-col gap-10">
              <OperationalLedger data={overviewQuery.data} />
              <div className="flex flex-col gap-4">
                <h2 className="text-[14px] font-semibold text-text">
                  Inference &amp; tool usage
                </h2>
                <SummaryContent data={overviewQuery.data.inference.summary} />
                <AgentBreakdown agents={overviewQuery.data.inference.byAgent} />
                <InstanceBreakdown
                  instances={overviewQuery.data.inference.byInstance}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
