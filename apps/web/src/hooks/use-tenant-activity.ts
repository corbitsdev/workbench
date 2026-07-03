import { useInfiniteQuery } from "@tanstack/react-query";
import { getTenantActivity } from "@workbench/client";

export const TENANT_ACTIVITY_PAGE_SIZE = 50;

/**
 * The TENANT-WIDE activity feed (CL-2743) — every principal's activity in the
 * tenant, newest first, keyset-paginated. This is the default Insights feed;
 * a per-principal drill-down uses the principal-scoped `usePrincipalActivity`
 * instead. Gated by the caller so it does not fire without a tenant.
 */
export function useTenantActivity(
  tenantId: string,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: ["tenant-activity", tenantId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      getTenantActivity(
        { init: { signal } },
        {
          tenantId,
          limit: TENANT_ACTIVITY_PAGE_SIZE,
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // PERF (CL-2743, greybeard): this is the DEFAULT Insights feed and runs the
    // heaviest tenant-wide UNION over interchange tables we cannot add indexes
    // to. Hold results fresh for 45s so re-opening Insights or re-rendering the
    // dashboard does not re-run the union on every mount. Page size stays a
    // bounded 50 (keyset-paginated) to cap the per-query scan.
    staleTime: 45_000,
    enabled: (options.enabled ?? true) && tenantId !== "",
  });
}
