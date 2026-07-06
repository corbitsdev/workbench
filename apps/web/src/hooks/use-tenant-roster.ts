import { useQuery } from "@tanstack/react-query";
import { getTenantRoster } from "@workbench/client";

/**
 * A tenant's agent instances + most recent workflow runs (CL-2798), keyed on
 * the tenant id. Powers the dashboard-level clickable Agents and Recent-runs
 * surfaces, where each item deep-links to its own trace. Gated on a tenant, and
 * treated as catalog-ish (5-min stale) alongside the dashboard's overview query.
 */
export function useTenantRoster(
  tenantId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["tenant-roster", tenantId],
    queryFn: ({ signal }) =>
      getTenantRoster({ init: { signal } }, { tenantId }),
    enabled: (options.enabled ?? true) && tenantId !== "",
    staleTime: 5 * 60_000,
  });
}
