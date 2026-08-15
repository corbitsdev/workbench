// One row in the Spaces band's "Working" group (see
// `apps/web/src/shell/panel-contributions.tsx`'s `ChannelsBand`): an
// agent's display name, elapsed time, and a live status treatment.
// Orange is reserved for a genuine needs-you state — react-ui's own
// `StatusDot`/`Badge` tone comments call the emphasis orange "rare on a
// screen", so a plain running task stays on the neutral tone.
import {
  Badge,
  formatRelativeTime,
  SidebarItemRow,
  StatusDot,
} from "@corbits/react-ui";

import type { Task } from "./api";

type WorkingTaskStatus = "queued" | "running" | "needs-you";

const STATUS_LABEL: Record<WorkingTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
};

export function WorkingTaskRow({
  task,
  displayName,
  onSelect,
}: {
  readonly task: Pick<Task, "status" | "createdAt">;
  readonly displayName: string;
  readonly onSelect: () => void;
}) {
  const status = task.status as WorkingTaskStatus;
  const needsYou = status === "needs-you";

  return (
    <SidebarItemRow
      leading={
        <StatusDot
          label={STATUS_LABEL[status]}
          live={status !== "queued"}
          tone={needsYou ? "emphasis" : "neutral"}
        />
      }
      name={<strong>{displayName}</strong>}
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
