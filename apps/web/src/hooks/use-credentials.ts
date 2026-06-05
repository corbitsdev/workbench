import { useQuery } from '@tanstack/react-query';
import { getMyPrincipals, listTenantCredentials } from '../lib/hub-api';
import type { Principal, CredentialDetail } from '../lib/hub-api';

export type { Principal, CredentialDetail };

export interface UseCredentialsResult {
  principals: Principal[];
  credentialsByTenant: Record<string, CredentialDetail[]>;
  isLoading: boolean;
}

export function useCredentials(): UseCredentialsResult {
  const principalsQuery = useQuery<Principal[]>({
    queryKey: ['me', 'principals'],
    queryFn: () => getMyPrincipals(),
  });

  const principals = principalsQuery.data ?? [];

  // Collect unique tenant IDs from principals
  const tenantIds = [...new Set(principals.map((p) => p.tenantId))];

  const credentialsQuery = useQuery<Record<string, CredentialDetail[]>>({
    queryKey: ['credentials', 'by-tenant', tenantIds],
    queryFn: async () => {
      const results = await Promise.all(
        tenantIds.map((id) => listTenantCredentials(id).then((creds) => ({ id, creds })))
      );
      return Object.fromEntries(results.map(({ id, creds }) => [id, creds]));
    },
    enabled: tenantIds.length > 0,
  });

  return {
    principals,
    credentialsByTenant: credentialsQuery.data ?? {},
    isLoading: principalsQuery.isLoading || credentialsQuery.isLoading,
  };
}
