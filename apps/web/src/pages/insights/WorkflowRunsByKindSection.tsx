import type { WorkflowKindRow } from "./overview-derivations";
import { SectionLabel } from "./section-label";
import { SortableWorkflowKindTable } from "./SortableWorkflowKindTable";

export function WorkflowRunsByKindSection({
  rows,
}: {
  rows: WorkflowKindRow[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Workflow runs by kind</SectionLabel>
      <SortableWorkflowKindTable rows={rows} />
    </div>
  );
}
