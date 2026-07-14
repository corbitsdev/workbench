import { Link } from "react-router";

import type { ActivityOverview } from "../../lib/hub-api";
import { CountTable } from "./CountTable";
import { SectionLabel } from "./section-label";
import { SortableWorkflowKindTable } from "./SortableWorkflowKindTable";
import type { WorkflowKindRow } from "./overview-derivations";

/**
 * Workflows tab (CL-3667): the single consolidated view of kind, status, and
 * recent runs — replacing the three prior renderings of "workflow runs by
 * kind" (a bar chart, a table with dead metric columns, and a plain count
 * list) with one kind table (with an honest usage-attribution marker), one
 * status summary, and a link into the paginated, filterable run list.
 */
export function WorkflowsTab({
  data,
  kindRows,
}: {
  data: ActivityOverview;
  kindRows: WorkflowKindRow[];
}) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <SectionLabel>Workflow runs by kind</SectionLabel>
        <SortableWorkflowKindTable rows={kindRows} />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Workflow runs by status</SectionLabel>
        <CountTable
          title="Workflow runs by status"
          rows={data.workflowRuns.byStatus}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Recent runs</SectionLabel>
          <Link
            to="/insights/runs"
            className="text-[12px] font-medium text-text-3 underline hover:text-text"
          >
            Open run history →
          </Link>
        </div>
        <p className="text-[11px] text-text-3">
          Run history lists every run in the workbench with kind, status, and
          search filters. When more than one person has started runs, you can
          filter by who started each run.
        </p>
      </div>
    </div>
  );
}
