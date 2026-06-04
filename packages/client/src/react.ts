// @workbench/client/react — TanStack Query hooks built on the root data-access
// functions. React and @tanstack/react-query are peer dependencies; the host
// app provides the QueryClientProvider.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ArtifactWithSession, WorkflowSummary } from '@workbench/shared';
import { listArtifacts, listWorkflows, type ClientOptions } from './index';

/** Query the current user's workflow sessions for the library rail. */
export function useLibraryResources(
  options: ClientOptions = {}
): UseQueryResult<WorkflowSummary[]> {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => listWorkflows(options),
  });
}

/** Query the current user's artifacts across all sessions for the gallery. */
export function useArtifacts(options: ClientOptions = {}): UseQueryResult<ArtifactWithSession[]> {
  return useQuery({
    queryKey: ['artifacts'],
    queryFn: () => listArtifacts(options),
  });
}
