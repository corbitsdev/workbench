import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart2 } from 'lucide-react';
import { useWorkbenches } from '../hooks/use-workbenches';
import {
  describeHubApiFailure,
  getAnalyticsSummary,
  getAnalyticsSummaryByAgent,
} from '../lib/hub-api';
import type { AnalyticsAgentRow, AnalyticsSummary } from '../lib/hub-api';

type Preset = '7d' | '30d' | '90d' | 'all';

const PRESETS: { label: string; value: Preset }[] = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
  { label: 'All time', value: 'all' },
];

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function presetToDates(preset: Preset): { startDate?: string; endDate?: string } {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
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
      <span className={`text-[24px] font-bold ${accent ? 'text-orange' : 'text-text'}`}>
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
      <span className="text-[13px] font-medium text-text">{formatNumber(value)}</span>
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

  const allZero = data.turnCount === 0 && data.toolCallCount === 0 && totalTokens === 0;

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
          <span className="text-[13px] font-semibold text-text">Token usage</span>
          <span className="text-[13px] font-bold text-text">{formatNumber(totalTokens)} total</span>
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
  return <div className="h-[92px] animate-pulse rounded-[12px] border border-border bg-surface" />;
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
              <th className="px-4 py-2 font-medium text-right">Tokens (in+out)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {agents.map((row) => (
              <tr key={row.agentId}>
                <td className="px-4 py-2 text-text">{row.agentName ?? row.agentId}</td>
                <td className="px-4 py-2 text-right text-text-2">{formatNumber(row.turnCount)}</td>
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
  const [preset, setPreset] = useState<Preset>('30d');
  const [tenantOverride, setTenantOverride] = useState<string | null>(null);
  const workbenches = useWorkbenches();
  const workbenchList = workbenches.data ?? [];

  const defaultTenantId = workbenchList[0]?.tenantId ?? null;
  const tenantId =
    tenantOverride && workbenchList.some((w) => w.tenantId === tenantOverride)
      ? tenantOverride
      : defaultTenantId;

  const activeWorkbench = workbenchList.find((w) => w.tenantId === tenantId) ?? null;

  const dates = presetToDates(preset);

  const summaryQuery = useQuery({
    queryKey: ['analytics-summary', tenantId, preset],
    queryFn: () => getAnalyticsSummary(tenantId!, dates),
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
  });

  const byAgentQuery = useQuery({
    queryKey: ['analytics-by-agent', tenantId, preset],
    queryFn: () => getAnalyticsSummaryByAgent(tenantId!, dates),
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
  });

  const showSummaryLoading = workbenches.isLoading || (!!tenantId && summaryQuery.isLoading);

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <div className="flex flex-1 flex-col overflow-hidden rounded-panel border border-border bg-bg">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 shrink-0 text-text-3" />
              <p className="text-[14px] font-semibold text-text">Data &amp; Insights</p>
            </div>
            {activeWorkbench && workbenchList.length === 1 && (
              <p className="truncate pl-6 text-[12px] text-text-3">{activeWorkbench.tenantName}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {workbenchList.length > 1 && (
              <label className="flex items-center gap-1.5 text-[12px] text-text-3">
                <span className="sr-only">Workbench</span>
                <select
                  className="rounded-[8px] border border-border bg-bg px-2 py-1 text-[12px] text-text"
                  value={tenantId ?? ''}
                  onChange={(e) => setTenantOverride(e.target.value)}
                >
                  {workbenchList.map((wb) => (
                    <option key={wb.tenantId} value={wb.tenantId}>
                      {wb.tenantName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex items-center gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPreset(p.value)}
                  className={`rounded-[8px] px-3 py-1 text-[12px] font-medium transition-colors ${
                    preset === p.value
                      ? 'bg-orange/10 text-orange'
                      : 'text-text-3 hover:bg-[var(--row-hover)] hover:text-text'
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

          {workbenches.isSuccess && !tenantId && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              No workbench is available for analytics yet.
            </div>
          )}

          {summaryQuery.isError && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              {describeHubApiFailure(summaryQuery.error)}
            </div>
          )}

          {summaryQuery.data && (
            <div className="flex flex-col gap-8">
              <SummaryContent data={summaryQuery.data} />
              {byAgentQuery.data && <AgentBreakdown agents={byAgentQuery.data} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
