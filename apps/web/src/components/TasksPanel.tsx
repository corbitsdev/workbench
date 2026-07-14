import {
  Badge,
  Button,
  DataTable,
  inputFieldClass,
  type DataTableColumn,
} from "@workbench/ui";
import {
  openTaskStatuses,
  taskStatusUrgency,
  type Task,
  type TaskStatus,
} from "@workbench/shared";
import { useCallback, useMemo, useState } from "react";
import {
  useBulkUpdateTaskStatus,
  useUpdateTaskStatus,
} from "../hooks/use-task-mutations";
import { ApiError } from "../lib/api";

const OPEN_STATUS_SET = new Set<string>(openTaskStatuses);

const statusLabel: Record<(typeof openTaskStatuses)[number], string> = {
  in_progress: "In progress",
  open: "Open",
  waiting: "Waiting",
};

const TERMINAL_STATUS_LABEL: Record<"done" | "cancelled", string> = {
  done: "Done",
  cancelled: "Dismissed",
};

function sortOpenTasks(tasks: Task[]): Task[] {
  return [...tasks]
    .filter((t) => OPEN_STATUS_SET.has(t.status))
    .sort((a, b) => {
      const ua =
        taskStatusUrgency[a.status as keyof typeof taskStatusUrgency] ?? 9;
      const ub =
        taskStatusUrgency[b.status as keyof typeof taskStatusUrgency] ?? 9;
      if (ua !== ub) return ua - ub;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export type TasksPanelProps = {
  tasks: Task[];
};

export function TasksPanel({ tasks }: TasksPanelProps) {
  const rows = useMemo(() => sortOpenTasks(tasks), [tasks]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const updateStatus = useUpdateTaskStatus();
  const bulkUpdate = useBulkUpdateTaskStatus();

  const reportTaskActionError = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      setTaskActionError(err.message || "Couldn't update your tasks.");
      return;
    }
    if (err instanceof Error) {
      setTaskActionError(err.message);
      return;
    }
    setTaskActionError("Couldn't update your tasks.");
  }, []);

  const allSelected =
    rows.length > 0 && rows.every((t) => selectedIds.has(t.id));
  const someSelected = rows.some((t) => selectedIds.has(t.id));
  const busy = updateStatus.isPending || bulkUpdate.isPending;

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(rows.map((t) => t.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function runBulk(status: TaskStatus) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setTaskActionError(null);
    bulkUpdate
      .mutateAsync({ ids, status })
      .then(() => setSelectedIds(new Set()))
      .catch(reportTaskActionError);
  }

  const columns = useMemo((): DataTableColumn<Task>[] => {
    return [
      {
        key: "select",
        header: "",
        className: "w-10",
        render: (task) => (
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={selectedIds.has(task.id)}
            disabled={busy}
            onChange={(e) => toggleOne(task.id, e.target.checked)}
            aria-label={`Select ${task.title}`}
          />
        ),
      },
      {
        key: "title",
        header: "Title",
        render: (task) => (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-foreground">{task.title}</span>
            {task.body ? (
              <span className="line-clamp-1 text-xs text-muted-foreground">
                {task.body}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        className: "w-[160px]",
        render: (task) => (
          <select
            className={`${inputFieldClass} h-8 py-1`}
            value={task.status}
            disabled={busy}
            aria-label="Task status"
            onChange={(e) => {
              setTaskActionError(null);
              updateStatus
                .mutateAsync({
                  taskId: task.id,
                  status: e.target.value as TaskStatus,
                })
                .catch(reportTaskActionError);
            }}
          >
            {openTaskStatuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
            <option value="done">{TERMINAL_STATUS_LABEL.done}</option>
            <option value="cancelled">{TERMINAL_STATUS_LABEL.cancelled}</option>
          </select>
        ),
      },
      {
        key: "updated",
        header: "Updated",
        className: "w-[120px]",
        render: (task) => (
          <Badge tone="neutral" className="font-normal">
            {new Date(task.updatedAt).toLocaleDateString()}
          </Badge>
        ),
      },
    ];
  }, [
    busy,
    reportTaskActionError,
    selectedIds,
    updateStatus,
  ]);

  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No open tasks. New work from the Now feed appears here.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
          <p className="text-xs text-muted-foreground">
            Reprioritize status or dismiss without leaving Inbox.
          </p>
        </div>
        {someSelected ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedIds.size} selected
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 text-xs"
              disabled={busy}
              onClick={() => runBulk("in_progress")}
            >
              Prioritize
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 text-xs"
              disabled={busy}
              onClick={() => runBulk("done")}
            >
              Complete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              disabled={busy}
              onClick={() => runBulk("cancelled")}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
      {taskActionError ? (
        <p className="mx-4 mt-3 text-sm text-red-600" role="alert">
          {taskActionError}
        </p>
      ) : null}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border"
          checked={allSelected}
          disabled={busy}
          onChange={(e) => toggleAll(e.target.checked)}
          aria-label="Select all tasks"
        />
        <span className="text-xs text-muted-foreground">Select all</span>
      </div>
      <div className="overflow-x-auto px-1 pb-1">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(task) => task.id}
          caption="Open tasks"
        />
      </div>
    </section>
  );
}