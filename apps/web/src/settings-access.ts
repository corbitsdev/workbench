// Rides the app's shared QueryClient so col2's nav band and the settings
// stage share one in-flight request instead of each fetching on mount.
// The `@/settings` package itself stays free of TanStack Query.

import { coalesceSectionAccess, probeSectionAccess } from "@/settings";
import type { TenancyAccess } from "@/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { tenantKeys } from "./query-client";

const LOADING_ACCESS: TenancyAccess = {
  people: "loading",
  roles: "loading",
  grants: "loading",
  credentials: "loading",
};

function coalesceTenancyAccess(
  previous: TenancyAccess | undefined,
  next: TenancyAccess,
): TenancyAccess {
  const prior = previous ?? LOADING_ACCESS;
  return {
    people: coalesceSectionAccess(prior.people, next.people),
    roles: coalesceSectionAccess(prior.roles, next.roles),
    grants: coalesceSectionAccess(prior.grants, next.grants),
    credentials: coalesceSectionAccess(prior.credentials, next.credentials),
  };
}

// A thrown evaluate is `error`, not `denied`; a refetch failure keeps the
// last allow/deny so gated nav doesn't vanish as if unauthorized.
export function useSettingsAccess(
  tenantId: string | null,
  principalId: string | null,
): TenancyAccess {
  const queryClient = useQueryClient();
  const enabled = tenantId !== null && principalId !== null;
  const queryKey =
    tenantId !== null && principalId !== null
      ? tenantKeys.settingsAccess(tenantId, principalId)
      : tenantKeys.settingsAccess("none", "none");
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TenancyAccess> => {
      if (tenantId === null || principalId === null) return LOADING_ACCESS;
      const previous = queryClient.getQueryData<TenancyAccess>(queryKey);
      const [people, roles, grants, credentials] = await Promise.all([
        probeSectionAccess(tenantId, principalId, "principal"),
        probeSectionAccess(tenantId, principalId, "role"),
        probeSectionAccess(tenantId, principalId, "grant"),
        probeSectionAccess(tenantId, principalId, "credential"),
      ]);
      return coalesceTenancyAccess(previous, {
        people,
        roles,
        grants,
        credentials,
      });
    },
    enabled,
  });

  return query.data ?? LOADING_ACCESS;
}
