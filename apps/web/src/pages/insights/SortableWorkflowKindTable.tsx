import { SortableTable, type SortableColumn } from "@workbench/ui";

import { humanizeKey, sumInferenceTokenClasses } from "./metrics";
import type { WorkflowKindRow } from "./overview-derivations";
import { formatNumber } from "./stats";

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
      header: "Turns",
      align: "right",
      sortValue: (r) => r.turnCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.turnCount)}
        </span>
      ),
    },
    {
      key: "toolCallCount",
      header: "Tool calls",
      align: "right",
      sortValue: (r) => r.toolCallCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.toolCallCount)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => sumInferenceTokenClasses(r),
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(sumInferenceTokenClasses(r))}
        </span>
      ),
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
