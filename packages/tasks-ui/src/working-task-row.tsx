// One row in the Spaces band's "Working" group (see
// `apps/web/src/shell/workbench-list.tsx`'s `WorkbenchList`): an
// agent's display name, elapsed time, and a live status treatment.
// Orange is reserved for a genuine needs-you state — react-ui's own
// `StatusDot`/`Badge` tone comments call the emphasis orange "rare on a
// screen", so a plain running task stays on the neutral tone. `task` is
// typed as `WorkingTask` (a `Task` with its status narrowed to
// queued/running/needs-you), not the full `Task` — a terminal-status task
// is a type error here, not just a runtime filter (see `./working-task.ts`
// and `./working-task.type-guard.ts`).
import {
  Badge,
  formatRelativeTime,
  SidebarItemRow,
  StatusDot,
} from "@corbits/react-ui";

import type { WorkingTask, WorkingTaskStatus } from "./working-task";

const STATUS_LABEL: Record<WorkingTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
};

export function WorkingTaskRow({
  task,
  onSelect,
}: {
  readonly task: Pick<WorkingTask, "status" | "createdAt" | "agentName">;
  readonly onSelect: () => void;
}) {
  const needsYou = task.status === "needs-you";

  return (
    <SidebarItemRow
      leading={
        <StatusDot
          label={STATUS_LABEL[task.status]}
          live={task.status !== "queued"}
          tone={needsYou ? "emphasis" : "neutral"}
        />
      }
      name={<strong>{task.agentName}</strong>}
      meta={
        <span className="panel-task-meta">
          <span>{formatRelativeTime(task.createdAt)}</span>
          {needsYou ? <Badge tone="accent">Needs you</Badge> : null}
        </span>
      }
      onSelect={onSelect}
    />
  );
}
