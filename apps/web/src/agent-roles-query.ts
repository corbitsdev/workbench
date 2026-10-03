// The roles a create form can offer: the tenant's live platform roles,
// read through react-query so the agent and workbench create surfaces share
// one loading/error/ready contract.
import { useQuery } from "@tanstack/react-query";

import { toAPIQuery, type APIQuery } from "@/lib/api-query";

import { listTenantRoles, type RoleOption } from "./agent-roles";

function tenantRolesKey(tenantId: string | null) {
  return ["tenant", tenantId ?? "none", "roles"] as const;
}

export function useTenantRoles(tenantId: string | null): APIQuery<readonly RoleOption[]> {
  const result = useQuery({
    queryKey: tenantRolesKey(tenantId),
    enabled: tenantId !== null,
    queryFn: () => listTenantRoles(tenantId as string),
  });
  return toAPIQuery(result);
}
