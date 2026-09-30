import { useQueries, useQuery } from "@tanstack/react-query";

import { fetchTenantDetail } from "../api";
import { tenantKeys } from "../query-client";
import { listCredentials } from "../settings/credentials-api";

const WORKSPACE = "Workspace";
const UNKNOWN_CREDENTIAL = "A credential";
const CREDENTIAL_PREFIX = "credential:";
const TENANT_PREFIX = "tenant:";

export type GrantNames = {
  /** "credential:crd_…" -> the credential's name; "tenant:<id>" -> the
   * bench name or "Workspace". Undefined for any other resource. */
  readonly resource: (resource: string) => string | undefined;
  /** Replaces every known tenant id inside `text` with its name. */
  readonly replaceTenantIds: (text: string) => string;
};

/** Names for ids that appear in a workbench's grants, from the tenant and
 * credential reads the rest of the app already caches. */
export function useGrantNames(workbenchTenantId: string): GrantNames {
  const own = useQuery({
    queryKey: tenantKeys.detail(workbenchTenantId),
    queryFn: () => fetchTenantDetail(workbenchTenantId),
    staleTime: 30_000,
  });
  const parentId = own.data?.parentId ?? null;
  const parent = useQuery({
    queryKey: tenantKeys.detail(parentId ?? "none"),
    queryFn: () => fetchTenantDetail(parentId ?? ""),
    enabled: parentId !== null,
    staleTime: 30_000,
  });
  const credentialScopes = parentId === null ? [workbenchTenantId] : [workbenchTenantId, parentId];
  const credentials = useQueries({
    queries: credentialScopes.map((tenantId) => ({
      queryKey: tenantKeys.credentials(tenantId),
      queryFn: () => listCredentials(tenantId),
    })),
  });

  const tenantNames = new Map<string, string>();
  if (own.data !== undefined) {
    tenantNames.set(workbenchTenantId, own.data.parentId === null ? WORKSPACE : own.data.name);
  }
  if (parentId !== null && parent.data !== undefined) tenantNames.set(parentId, WORKSPACE);
  const credentialNames = new Map<string, string>();
  for (const result of credentials) {
    for (const credential of result.data ?? []) credentialNames.set(credential.id, credential.name);
  }

  return {
    resource: (resource) => {
      if (resource.startsWith(CREDENTIAL_PREFIX)) {
        return credentialNames.get(resource.slice(CREDENTIAL_PREFIX.length)) ?? UNKNOWN_CREDENTIAL;
      }
      if (resource.startsWith(TENANT_PREFIX)) {
        return tenantNames.get(resource.slice(TENANT_PREFIX.length)) ?? WORKSPACE;
      }
      return undefined;
    },
    replaceTenantIds: (text) => {
      let out = text;
      for (const [id, name] of tenantNames) out = out.split(id).join(name);
      return out;
    },
  };
}
