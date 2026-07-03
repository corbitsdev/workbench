import { useQuery } from "@tanstack/react-query";
import { getActor, type Actor } from "@workbench/client";

const ACTOR_STALE_MS = 5 * 60_000;

/**
 * Resolve a single principal's actor identity by id
 * (`GET /api/tenants/:tenantId/actors/:principalId`). Deep-linkable: when a
 * caller has an already-loaded actor for THIS principal, pass it as
 * `placeholder` so identity renders instantly while the fetch confirms it.
 * Gated on a non-empty tenant + principal id.
 */
export function useActor(
  tenantId: string,
  principalId: string,
  placeholder: Actor | null,
) {
  return useQuery({
    queryKey: ["actor", tenantId, principalId],
    queryFn: ({ signal }) =>
      getActor({ init: { signal } }, { tenantId, principalId }),
    enabled: tenantId !== "" && principalId !== "",
    staleTime: ACTOR_STALE_MS,
    ...(placeholder ? { placeholderData: placeholder } : {}),
  });
}
