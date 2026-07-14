import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { TaskSchema, type Task } from "@workbench/shared";
import { api } from "../lib/api";
import { TASKS_QUERY_KEY } from "./use-tasks";

export type AssignTaskVars = {
  taskId: string;
  /** `null` clears the assignee. */
  assigneePrincipalId: string | null;
};

// Fires the task owner's assignee-picker choice at PATCH /me/tasks/:id. On
// success the shared tasks cache is invalidated so the row (and any open
// detail view) picks up the new assignee immediately.
export function useAssignTask() {
  const queryClient = useQueryClient();
  return useMutation<Task, Error, AssignTaskVars>({
    mutationFn: async ({ taskId, assigneePrincipalId }) => {
      const raw = await api<unknown>(
        "PATCH",
        `/me/tasks/${encodeURIComponent(taskId)}`,
        { assigneePrincipalId },
      );
      const parsed = TaskSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected task response: ${parsed.summary}`);
      }
      return parsed;
    },
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}
