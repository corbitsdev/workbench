import { useQuery } from "@tanstack/react-query";
import { getTenantToolBreakdown } from "@workbench/client";

/**
 * The tenant-wide per-tool call breakdown
 * (`GET /api/tenants/:tenantId/activity/tool-breakdown`), aggregated from the
 * durable analytics_event facts. Feeds the Usage & Cost tab's per-tool table.
 * Gated on a non-empty tenant id.
 */
export function useTenantToolBreakdown(
  tenantId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["tenant-tool-breakdown", tenantId],
    queryFn: ({ signal }) =>
      getTenantToolBreakdown({ init: { signal } }, { tenantId }),
    enabled: (options.enabled ?? true) && tenantId !== "",
    staleTime: 5 * 60_000,
  });
}
