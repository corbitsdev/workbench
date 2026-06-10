// @workbench/client/react — TanStack Query hooks built on the root data-access
// functions. React and @tanstack/react-query are peer dependencies; the host
// app provides the QueryClientProvider.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ArtifactWithSession, WorkflowSummary } from '@workbench/shared';
import { listArtifacts, listWorkflows, type ClientOptions } from './index';

export interface UseLibraryResourcesParams {
  tenantId?: string | null;
}

/** Query the current user's jobs for the library rail. */
export function useLibraryResources(
  options: ClientOptions = {},
  params: UseLibraryResourcesParams = {}
): UseQueryResult<WorkflowSummary[]> {
  return useQuery({
    queryKey: ['workflows', params.tenantId ?? null],
    queryFn: () => listWorkflows(options, params),
    enabled: params.tenantId != null,
    refetchInterval: 5000,
  });
}

export interface UseArtifactsParams {
  tenantId?: string | null;
  query?: string;
}

/** Query the current user's artifacts across all jobs for the gallery. */
export function useArtifacts(
  options: ClientOptions = {},
  params: UseArtifactsParams = {}
): UseQueryResult<ArtifactWithSession[]> {
  return useQuery({
    queryKey: ['artifacts', params.tenantId ?? null, params.query ?? ''],
    queryFn: () => listArtifacts(options, params),
    enabled: params.tenantId != null,
  });
}
