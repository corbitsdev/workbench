import { useQuery } from "@tanstack/react-query";
import { getPrincipalAnalytics } from "@workbench/client";

/**
 * A principal's tool-call breakdown and token/cost totals
 * (`GET /api/tenants/:tenantId/principals/:principalId/analytics`), aggregated
 * from the durable analytics_event facts. Feeds both the Tools and Cost facets;
 * TanStack dedupes the shared query key so the two facets issue one request.
 * Gated on a non-empty tenant + principal id.
 */
export function usePrincipalAnalytics(
  tenantId: string,
  principalId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["principal-analytics", tenantId, principalId],
    queryFn: ({ signal }) =>
      getPrincipalAnalytics({ init: { signal } }, { tenantId, principalId }),
    enabled: options.enabled ?? true,
  });
}
