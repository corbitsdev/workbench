import type { ActivityOverview } from "../../lib/hub-api";
import { formatNumber, Stat } from "./stats";
import { SectionLabel } from "./section-label";
import { CountTable } from "./CountTable";

export function OperationalLedger({ data }: { data: ActivityOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Operational ledger</SectionLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Artifacts"
          value={formatNumber(data.artifacts.total)}
          sub={`${formatNumber(data.artifacts.createdInRange)} in range`}
        />
        <Stat
          label="Workflow runs"
          value={formatNumber(data.workflowRuns.executionRecords)}
          sub={`${formatNumber(data.workflowRuns.activeExecutions)} active`}
        />
        <Stat
          label="Agents deployed"
          value={formatNumber(data.agentInstances.total)}
          sub={`${formatNumber(data.agentInstances.active)} active`}
        />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
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
