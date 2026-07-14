import { useState } from "react";
import { ConfirmButton } from "@workbench/ui";
import {
  adapterLabel,
  TASK_ADAPTER_CATALOG,
  type Task,
} from "@workbench/shared";
import { TaskExternalRefChip } from "./TaskExternalRefChip";
import { useTaskPush } from "../hooks/use-task-push";

// A task is eligible to send to an adapter it has no live ref for yet — a
// `synced` or `pending` ref already covers that adapter (its chip already
// renders); a `detached` ref is treated as never-sent, so the member can
// re-send to it.
function uncoveredAdapterIds(task: Task): string[] {
  const covered = new Set(
    task.externalRefs
      .filter((ref) => ref.syncState !== "detached")
      .map((ref) => ref.adapterId),
  );
  return TASK_ADAPTER_CATALOG.map((entry) => entry.id).filter(
    (id) => !covered.has(id),
  );
}

/**
 * Renders a task's downstream-sync row: a chip for every live external ref,
 * plus a "Send to <adapter>" action (behind a confirm click) for every
 * configured adapter the task has no ref for yet. While a send is in flight,
 * the button for that adapter is replaced by an optimistic "sending" chip so
 * the row never looks like nothing happened; a failure surfaces a
 * plain-language inline message for this actor only (never an ambient error
 * state on the task itself).
 */
export function TaskSendToAdapter({ task }: { task: Task }) {
  const [sendingAdapterId, setSendingAdapterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const push = useTaskPush();

  const uncovered = uncoveredAdapterIds(task);
  if (task.externalRefs.length === 0 && uncovered.length === 0) return null;

  const handleSend = (adapterId: string) => {
    setError(null);
    setSendingAdapterId(adapterId);
    push
      .mutateAsync({ taskId: task.id, adapterId })
      .catch(() => {
        const label = adapterLabel(adapterId);
        setError(`Could not send this task to ${label}. Try again.`);
      })
      .finally(() => setSendingAdapterId(null));
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {task.externalRefs.map((ref) => (
        <TaskExternalRefChip key={ref.adapterId} externalRef={ref} />
      ))}
      {uncovered.map((adapterId) => {
        const label = adapterLabel(adapterId);
        if (sendingAdapterId === adapterId && push.isPending) {
          return (
            <TaskExternalRefChip
              key={adapterId}
              externalRef={{
                adapterId,
                externalId: "",
                syncState: "pending",
              }}
            />
          );
        }
        // The push mutation is single-flight for this task (one shared
        // useTaskPush per row), so a send in flight for another adapter
        // disables this button too rather than racing a second push —
        // the title tells the actor why, since a disabled control with no
        // explanation is indistinguishable from a broken one.
        const disabledByOtherSend =
          push.isPending && sendingAdapterId !== adapterId;
        return (
          <span
            key={adapterId}
            title={
              disabledByOtherSend ? "Another send is in progress" : undefined
            }
          >
            <ConfirmButton
              variant="ghost"
              size="sm"
              disabled={push.isPending}
              confirmLabel={`Confirm send to ${label}`}
              onConfirm={() => handleSend(adapterId)}
            >
              Send to {label}
            </ConfirmButton>
          </span>
        );
      })}
      {error && <span className="text-[11px] text-red">{error}</span>}
    </div>
  );
}
