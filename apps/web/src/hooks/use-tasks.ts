import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { TaskListResponseSchema, type Task } from "@workbench/shared";
import { api } from "../lib/api";

export type { Task };

// User-scoped like the mailbox (/me/tasks resolves the caller's principal), so
// the key carries no tenant. Shared by the inbox Now feed and any future task
// surface so they read one cache.
export const TASKS_QUERY_KEY = ["tasks"] as const;

export function useTasks(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useQuery<Task[]>({
    queryKey: TASKS_QUERY_KEY,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    queryFn: async () => {
      const raw = await api<unknown>("GET", "/me/tasks");
      const parsed = TaskListResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected tasks response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}
