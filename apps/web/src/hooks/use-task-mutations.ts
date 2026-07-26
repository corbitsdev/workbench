import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { type } from "arktype";
import {
  TaskBulkPatchResponseSchema,
  TaskSchema,
  type Task,
  type TaskStatus,
} from "@workbench/shared";
import { api } from "../lib/api";
import { TASKS_QUERY_KEY } from "./use-tasks";

type TasksPage = {
  items: Task[];
  nextCursor?: string;
};

function patchTasksPages(
  previous: InfiniteData<TasksPage> | undefined,
  ids: Set<string>,
  patch: (task: Task) => Task | null,
): InfiniteData<TasksPage> | undefined {
  if (!previous) return previous;
  return {
    ...previous,
    pages: previous.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((task) => {
        if (!ids.has(task.id)) return [task];
        const next = patch(task);
        return next === null ? [] : [next];
      }),
    })),
  };
}

function snapshotTasks(
  queryClient: ReturnType<typeof useQueryClient>,
): [readonly unknown[], InfiniteData<TasksPage> | undefined][] {
  return queryClient.getQueriesData<InfiniteData<TasksPage>>({
    queryKey: TASKS_QUERY_KEY,
  });
}

function applyTaskPatch(
  queryClient: ReturnType<typeof useQueryClient>,
  ids: Set<string>,
  patch: (task: Task) => Task | null,
) {
  for (const [key, previous] of snapshotTasks(queryClient)) {
    queryClient.setQueryData(key, patchTasksPages(previous, ids, patch));
  }
}

function rollbackTasks(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots:
    | [readonly unknown[], InfiniteData<TasksPage> | undefined][]
    | undefined,
) {
  for (const [key, previous] of snapshots ?? []) {
    queryClient.setQueryData(key, previous);
  }
}

export type UpdateTaskStatusVars = {
  taskId: string;
  status: TaskStatus;
};

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();
  return useMutation<
    Task,
    Error,
    UpdateTaskStatusVars,
    { snapshots: ReturnType<typeof snapshotTasks> }
  >({
    mutationFn: async ({ taskId, status }) => {
      const raw = await api<unknown>(
        "PATCH",
        `/me/tasks/${encodeURIComponent(taskId)}`,
        { status },
      );
      const parsed = TaskSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected task response: ${parsed.summary}`);
      }
      return parsed;
    },
    onMutate: async ({ taskId, status }) => {
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      const snapshots = snapshotTasks(queryClient);
      const ids = new Set([taskId]);
      applyTaskPatch(queryClient, ids, (task) => {
        const next = { ...task, status, updatedAt: new Date().toISOString() };
        if (status === "done" || status === "cancelled") return null;
        return next;
      });
      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      rollbackTasks(queryClient, context?.snapshots);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}

export type BulkUpdateTaskStatusVars = {
  ids: string[];
  status: TaskStatus;
};

export function useBulkUpdateTaskStatus() {
  const queryClient = useQueryClient();
  return useMutation<
    { updated: number; ids: string[] },
    Error,
    BulkUpdateTaskStatusVars,
    { snapshots: ReturnType<typeof snapshotTasks> }
  >({
    mutationFn: async ({ ids, status }) => {
      const raw = await api<unknown>("POST", "/me/tasks/bulk", { ids, status });
      const parsed = TaskBulkPatchResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected bulk task response: ${parsed.summary}`);
      }
      return parsed;
    },
    onMutate: async ({ ids, status }) => {
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      const snapshots = snapshotTasks(queryClient);
      const idSet = new Set(ids);
      applyTaskPatch(queryClient, idSet, (task) => {
        const next = { ...task, status, updatedAt: new Date().toISOString() };
        if (status === "done" || status === "cancelled") return null;
        return next;
      });
      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      rollbackTasks(queryClient, context?.snapshots);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}
