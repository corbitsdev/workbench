import { useQuery } from "@tanstack/react-query";
import { getPrincipalRoster } from "@workbench/client";

/**
 * A principal's owned agent instances + workflow runs (CL-2737), keyed on the
 * principal id. Powers the "Agents & workflows" roster facet, where each item
 * deep-links to its own trace. Gated by the caller so it does not fire without
 * a tenant + principal.
 */
export function usePrincipalRoster(
  tenantId: string,
  principalId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["principal-roster", tenantId, principalId],
    queryFn: ({ signal }) =>
      getPrincipalRoster({ init: { signal } }, { tenantId, principalId }),
    enabled: options.enabled ?? true,
  });
}
