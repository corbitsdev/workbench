import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orderCatalogEntries, type WorkflowCatalog } from "@workbench/shared";
import { getWorkflowsCatalog, patchMePreferences } from "../lib/hub-api";

function catalogKey(tenantId?: string | null) {
  return ["workflows-catalog", tenantId ?? null] as const;
}

// The single page-load query: catalog entries with favorites and step flows.
export function useWorkflowsCatalog(
  tenantId?: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery<WorkflowCatalog>({
    queryKey: catalogKey(tenantId),
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
    queryFn: () => getWorkflowsCatalog(tenantId),
  });
}

// Toggling a favorite optimistically re-pins the catalog, then persists the new
// favoriteWorkflows array via the member-preferences patch. onMutate runs before
// mutationFn, so the patch reads the already-toggled cache for the array to save.
export function useToggleWorkflowFavorite(tenantId?: string | null) {
  const queryClient = useQueryClient();
  const key = catalogKey(tenantId);

  return useMutation<
    unknown,
    Error,
    { kind: string; nextFavorite: boolean },
    { previous: WorkflowCatalog | undefined }
  >({
    mutationFn: () => {
      const current = queryClient.getQueryData<WorkflowCatalog>(key);
      const favoriteKinds = (current?.entries ?? [])
        .filter((e) => e.isFavorite)
        .map((e) => e.kind);
      return patchMePreferences({ favoriteWorkflows: favoriteKinds });
    },
    onMutate: async ({ kind, nextFavorite }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkflowCatalog>(key);
      if (previous) {
        const entries = previous.entries.map((e) =>
          e.kind === kind ? { ...e, isFavorite: nextFavorite } : e,
        );
        const favoriteKinds = entries
          .filter((e) => e.isFavorite)
          .map((e) => e.kind);
        queryClient.setQueryData<WorkflowCatalog>(key, {
          entries: orderCatalogEntries(entries, favoriteKinds),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
