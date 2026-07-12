import { useState } from "react";
import { ConfirmButton } from "@workbench/ui";
import { TASK_ADAPTER_CATALOG, type Task } from "@workbench/shared";
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
  const [sendingAdapterId, setSendingAdapterId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const push = useTaskPush();

  const uncovered = uncoveredAdapterIds(task);
  if (task.externalRefs.length === 0 && uncovered.length === 0) return null;

  const handleSend = (adapterId: string) => {
    setError(null);
    setSendingAdapterId(adapterId);
    push
      .mutateAsync({ taskId: task.id, adapterId })
      .catch((err: unknown) => {
        const label =
          TASK_ADAPTER_CATALOG.find((e) => e.id === adapterId)?.label ??
          adapterId;
        setError(
          err instanceof Error
            ? err.message
            : `Could not send this task to ${label}.`,
        );
      })
      .finally(() => setSendingAdapterId(null));
  };

  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      onClick={(event) => event.stopPropagation()}
    >
      {task.externalRefs.map((ref) => (
        <TaskExternalRefChip key={ref.adapterId} externalRef={ref} />
      ))}
      {uncovered.map((adapterId) => {
        const label =
          TASK_ADAPTER_CATALOG.find((e) => e.id === adapterId)?.label ??
          adapterId;
        if (sendingAdapterId === adapterId && push.isPending) {
          return (
            <span
              key={adapterId}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-page px-2 py-0.5 text-[11px] font-medium text-text-3"
            >
              {label} · sending
            </span>
          );
        }
        return (
          <ConfirmButton
            key={adapterId}
            variant="ghost"
            size="sm"
            disabled={push.isPending}
            confirmLabel={`Confirm send to ${label}`}
            onConfirm={() => handleSend(adapterId)}
          >
            Send to {label}
          </ConfirmButton>
        );
      })}
      {error && <span className="text-[11px] text-red">{error}</span>}
    </div>
  );
}
