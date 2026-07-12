import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import {
  PushTaskResponseSchema,
  type PushTaskResponse,
} from "@workbench/shared";
import { api } from "../lib/api";
import { TASKS_QUERY_KEY } from "./use-tasks";

export type PushTaskVars = {
  taskId: string;
  adapterId: string;
};

// Fires the member's explicit "send to adapter" click at POST
// /me/tasks/:id/push. The click itself is the approval (see the route's
// summary) — no additional confirmation rail is consulted here. On success the
// shared tasks cache is invalidated so the row picks up the fresh externalRefs
// (linked, or still pending) on the next render.
export function useTaskPush() {
  const queryClient = useQueryClient();
  return useMutation<PushTaskResponse, Error, PushTaskVars>({
    mutationFn: async ({ taskId, adapterId }) => {
      const raw = await api<unknown>(
        "POST",
        `/me/tasks/${encodeURIComponent(taskId)}/push`,
        { adapterId },
      );
      const parsed = PushTaskResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected push response: ${parsed.summary}`);
      }
      return parsed;
    },
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}
