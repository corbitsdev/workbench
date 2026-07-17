import { SortableTable, type SortableColumn } from "@workbench/ui";

import { humanizeKey, sumInferenceTokenClasses } from "./metrics";
import type { WorkflowKindRow } from "./overview-derivations";
import { formatNumber } from "./stats";

/** Renders a usage metric, or an honest "no usage data" marker when the kind
 * never matched the deployment-attribution join — never a bare, misleading 0
 * (CL-3667, AC9/AC10). */
function UsageCell({ row, value }: { row: WorkflowKindRow; value: number }) {
  if (!row.hasUsageData) {
    return (
      <span
        title="No inference usage was attributed to this workflow kind — the usage join requires a recorded deployment id, which older or non-deployment runs may lack"
        className="rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-3"
      >
        no usage data
      </span>
    );
  }
  return <span className="font-mono tabular-nums">{formatNumber(value)}</span>;
}

export function SortableWorkflowKindTable({
  rows,
}: {
  rows: WorkflowKindRow[];
}) {
  const columns: SortableColumn<WorkflowKindRow>[] = [
    {
      key: "kind",
      header: "Workflow kind",
      sortValue: (r) => r.kind,
      render: (r) => humanizeKey(r.kind),
    },
    {
      key: "runs",
      header: "Runs",
      align: "right",
      sortValue: (r) => r.runs,
      render: (r) => (
        <span className="font-mono tabular-nums">{formatNumber(r.runs)}</span>
      ),
    },
    {
      key: "turnCount",
      header: "Chats",
      align: "right",
      sortValue: (r) => r.turnCount,
      render: (r) => <UsageCell row={r} value={r.turnCount} />,
    },
    {
      key: "toolCallCount",
      header: "Tool calls",
      align: "right",
      sortValue: (r) => r.toolCallCount,
      render: (r) => <UsageCell row={r} value={r.toolCallCount} />,
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => sumInferenceTokenClasses(r),
      render: (r) => <UsageCell row={r} value={sumInferenceTokenClasses(r)} />,
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.kind}
      caption="Workflow runs by kind"
      initialSort={{ key: "runs", dir: "desc" }}
      pageSize={10}
      emptyMessage="No workflow runs for this range"
    />
  );
}
