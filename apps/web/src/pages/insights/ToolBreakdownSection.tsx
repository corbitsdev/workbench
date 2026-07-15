import { SortableTable, type SortableColumn } from "@workbench/ui";
import type { PrincipalToolRow } from "@workbench/client";
import { useTenantToolBreakdown } from "../../hooks/use-tenant-tool-breakdown";
import { CaveatNote, HudCard, formatNumber } from "./stats";
import { SectionLabel } from "./section-label";

/** Errors-over-calls as a percentage, or null when the tool has zero calls. */
function errorRate(row: PrincipalToolRow): number | null {
  return row.calls > 0 ? row.errors / row.calls : null;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ToolBreakdownTable({ rows }: { rows: PrincipalToolRow[] }) {
  const columns: SortableColumn<PrincipalToolRow>[] = [
    {
      key: "name",
      header: "Tool",
      sortValue: (r) => r.name.toLowerCase(),
      render: (r) => <span className="text-text">{r.name}</span>,
    },
    {
      key: "calls",
      header: "Calls",
      align: "right",
      sortValue: (r) => r.calls,
      render: (r) => (
        <span className="font-mono tabular-nums">{formatNumber(r.calls)}</span>
      ),
    },
    {
      key: "errors",
      header: "Errors",
      align: "right",
      sortValue: (r) => r.errors,
      render: (r) => (
        <span className="font-mono tabular-nums">{formatNumber(r.errors)}</span>
      ),
    },
    {
      key: "errorRate",
      header: "Error rate",
      align: "right",
      sortValue: (r) => errorRate(r) ?? -1,
      render: (r) => {
        const rate = errorRate(r);
        if (rate === null) {
          return <span className="text-text-3">—</span>;
        }
        return (
          <span
            className={`font-mono tabular-nums ${
              rate > 0 ? "text-red-500" : "text-text-3"
            }`}
          >
            {formatPercent(rate)}
          </span>
        );
      },
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.name}
      caption="Tool usage"
      initialSort={{ key: "calls", dir: "desc" }}
      pageSize={10}
      emptyMessage="No tool calls recorded for this workbench yet"
    />
  );
}

/**
 * Tenant-wide per-tool usage breakdown for the Usage & Cost tab (CL-3667). Lists
 * every tool the workbench has called with its call count and — where tool
 * errors were recorded — the error rate, paginated. Complements the per-model
 * cost table (tokens/dollars) with the tool-call dimension the cost view omits.
 */
export function ToolBreakdownSection({ tenantId }: { tenantId: string }) {
  const { data, isLoading, isError, refetch } =
    useTenantToolBreakdown(tenantId);

  return (
    <div className="flex flex-col gap-4" data-testid="tool-breakdown">
      <SectionLabel>Tool usage</SectionLabel>
      <HudCard label="Calls by tool">
        <CaveatNote>
          Every tool the workbench has called, across all people and workflows.
          Error rate is shown where the tool reported a failure; a dash means no
          errors were recorded for that tool.
        </CaveatNote>
        {isLoading && (
          <div
            className="h-[120px] animate-pulse rounded-[12px] border border-border bg-surface-2"
            data-testid="tool-breakdown-loading"
          />
        )}
        {!isLoading && isError && (
          <div className="flex flex-col items-start gap-2 text-[13px] text-text-2">
            <span>Couldn&rsquo;t load tool usage.</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="text-blue underline hover:text-blue-deep"
            >
              Try again
            </button>
          </div>
        )}
        {!isLoading && !isError && (
          <ToolBreakdownTable rows={data?.tools ?? []} />
        )}
      </HudCard>
    </div>
  );
}
