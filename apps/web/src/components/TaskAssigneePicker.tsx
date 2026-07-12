import { useState } from "react";
import { UserPlus } from "lucide-react";
import { cn, Menu, MenuContent, MenuItem, MenuTrigger } from "@workbench/ui";
import type { Task } from "@workbench/shared";
import { useMembers } from "../hooks/use-members";
import { useAssignTask } from "../hooks/use-task-assign";

// Assignment is owner-only (see PATCH /me/tasks/:id). A non-owner viewer
// (the current assignee, or nobody) sees the assignee as a plain label, if
// one is set, and nothing otherwise — never a control they can't use.
export function TaskAssigneePicker({
  task,
  tenantId,
  myPrincipalId,
}: {
  task: Task;
  tenantId: string | null;
  myPrincipalId: string | null;
}) {
  const isOwner =
    myPrincipalId !== null && myPrincipalId === task.ownerPrincipalId;
  // Fetched for owner and non-owner alike — a non-owner assignee still needs
  // the member name to render the read-only "Assigned to <name>" label.
  const { data: members } = useMembers(tenantId);
  const assign = useAssignTask();
  const [error, setError] = useState<string | null>(null);

  const assigneeName =
    task.assigneePrincipalId === undefined
      ? null
      : (members?.find((m) => m.id === task.assigneePrincipalId)?.name ??
        (task.assigneePrincipalId === myPrincipalId ? "You" : "Someone"));

  if (!isOwner) {
    if (!assigneeName) return null;
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-page px-2 py-0.5 text-[11px] font-medium text-text-3">
        Assigned to {assigneeName}
      </span>
    );
  }

  const handlePick = (assigneePrincipalId: string | null) => {
    setError(null);
    assign
      .mutateAsync({ taskId: task.id, assigneePrincipalId })
      .catch(() => setError("Could not update the assignee. Try again."));
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            disabled={assign.isPending}
            aria-label="Assign task"
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-border bg-page px-2 py-0.5 text-[11px] font-medium text-text-3 transition-colors hover:border-border-strong hover:text-text",
              assign.isPending && "opacity-60",
            )}
          >
            <UserPlus size={11} aria-hidden="true" />
            {assigneeName ?? "Assign"}
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          {task.assigneePrincipalId && (
            <MenuItem onSelect={() => handlePick(null)}>Unassign</MenuItem>
          )}
          {(members ?? [])
            .filter((m) => m.id !== task.assigneePrincipalId)
            .map((m) => (
              <MenuItem key={m.id} onSelect={() => handlePick(m.id)}>
                {m.name}
              </MenuItem>
            ))}
        </MenuContent>
      </Menu>
      {error && <span className="text-[11px] text-red">{error}</span>}
    </div>
  );
}
