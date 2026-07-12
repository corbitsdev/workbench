import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { TaskListResponseSchema, TaskSchema, type Task } from "@workbench/shared";
import { api, ApiError } from "../lib/api";

export type { Task };

// User-scoped like the mailbox (/me/tasks resolves the caller's principal), so
// the key carries no tenant. Shared by the inbox Now feed and any future task
// surface so they read one cache.
export const TASKS_QUERY_KEY = ["tasks"] as const;

// Matches the hub's DEFAULT_TASKS_PAGE_LIMIT (apps/hub/src/routes/me-tasks.ts)
// so a page here is exactly one hub page.
export const TASKS_PAGE_LIMIT = 50;

type TasksPage = typeof TaskListResponseSchema.infer;

async function fetchTasksPage(cursor: string | undefined): Promise<TasksPage> {
  const params = new URLSearchParams({ limit: String(TASKS_PAGE_LIMIT) });
  if (cursor !== undefined) params.set("cursor", cursor);
  const raw = await api<unknown>("GET", `/me/tasks?${params.toString()}`);
  const parsed = TaskListResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected tasks response: ${parsed.summary}`);
  }
  return parsed;
}

export function useTasks(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useInfiniteQuery({
    queryKey: TASKS_QUERY_KEY,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchTasksPage(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

// A single task fetched directly by id, independent of which pages of
// /me/tasks have been loaded. Used to resolve the honest state for a
// `?task=<id>` deep link that points past the loaded window: the task may
// still be open (just further down the feed), closed, or genuinely gone.
export function useTask(id: string | null) {
  return useQuery<Task, ApiError>({
    queryKey: [...TASKS_QUERY_KEY, "item", id],
    enabled: id !== null,
    queryFn: async () => {
      if (id === null) {
        throw new Error("No task selected");
      }
      const raw = await api<unknown>("GET", `/me/tasks/${encodeURIComponent(id)}`);
      const parsed = TaskSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected task response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

export function isTaskNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
