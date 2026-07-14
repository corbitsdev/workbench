import {
  Badge,
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workbench/ui";
import {
  openTaskStatuses,
  taskStatusUrgency,
  type Task,
  type TaskStatus,
} from "@workbench/shared";
import { useMemo, useState } from "react";
import {
  useBulkUpdateTaskStatus,
  useUpdateTaskStatus,
} from "../hooks/use-task-mutations";

const OPEN_STATUS_SET = new Set<string>(openTaskStatuses);

const statusLabel: Record<(typeof openTaskStatuses)[number], string> = {
  in_progress: "In progress",
  open: "Open",
  waiting: "Waiting",
};

function sortOpenTasks(tasks: Task[]): Task[] {
  return [...tasks]
    .filter((t) => OPEN_STATUS_SET.has(t.status))
    .sort((a, b) => {
      const ua = taskStatusUrgency[a.status as keyof typeof taskStatusUrgency] ?? 9;
      const ub = taskStatusUrgency[b.status as keyof typeof taskStatusUrgency] ?? 9;
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
  const updateStatus = useUpdateTaskStatus();
  const bulkUpdate = useBulkUpdateTaskStatus();

  const allSelected =
    rows.length > 0 && rows.every((t) => selectedIds.has(t.id));
  const someSelected = rows.some((t) => selectedIds.has(t.id));
  const busy = updateStatus.isPending || bulkUpdate.isPending;

  function toggleAll(checked: boolean) {
    setSelectedIds(
      checked ? new Set(rows.map((t) => t.id)) : new Set(),
    );
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
    bulkUpdate.mutate(
      { ids, status },
      {
        onSuccess: () => setSelectedIds(new Set()),
      },
    );
  }

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
              disabled={busy}
              onClick={() => runBulk("in_progress")}
            >
              Prioritize
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => runBulk("done")}
            >
              Complete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runBulk("cancelled")}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => toggleAll(v === true)}
                aria-label="Select all tasks"
              />
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="w-[140px]">Status</TableHead>
            <TableHead className="w-[120px]">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((task) => (
            <TableRow key={task.id}>
              <TableCell>
                <Checkbox
                  checked={selectedIds.has(task.id)}
                  onCheckedChange={(v) => toggleOne(task.id, v === true)}
                  aria-label={`Select ${task.title}`}
                />
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-foreground">{task.title}</span>
                  {task.description ? (
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {task.description}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <Select
                  value={task.status}
                  disabled={busy}
                  onValueChange={(value) => {
                    updateStatus.mutate({
                      taskId: task.id,
                      status: value as TaskStatus,
                    });
                  }}
                >
                  <SelectTrigger className="h-8" aria-label="Task status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {openTaskStatuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusLabel[s]}
                      </SelectItem>
                    ))}
                    <SelectItem value="done">Done</SelectItem>
                    <SelectItem value="cancelled">Dismissed</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <Badge variant="outline" className="font-normal">
                  {new Date(task.updatedAt).toLocaleDateString()}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}