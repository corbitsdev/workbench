import { useQuery } from "@tanstack/react-query";
import { getTenantRoster } from "@workbench/client";

/**
 * A tenant's agent instances + most recent workflow runs (CL-2798), keyed on
 * the tenant id. Powers the dashboard-level clickable Agents and Recent-runs
 * surfaces, where each item deep-links to its own trace.
 *
 * The roster also drives the live-pulse indicator on active agents
 * (CL-4417): a run/agent that just ended must stop pulsing within seconds,
 * not sit on a 5-min stale cache (CL-4419). So this query stays fresh with a
 * short staleTime plus a foreground poll, instead of the catalog-ish 5-min
 * staleTime other Insights queries use — it is not static/catalog data.
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
    staleTime: 20_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
  });
}
