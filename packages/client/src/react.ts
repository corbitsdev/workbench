// @workbench/client/react — TanStack Query hooks built on the root data-access
// functions. React and @tanstack/react-query are peer dependencies; the host
// app provides the QueryClientProvider.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ArtifactStatus, ArtifactWithSession, WorkflowSummary } from '@workbench/shared';
import {
  listArtifacts,
  listWorkflows,
  listMyRuns,
  listMembers,
  type ClientOptions,
  type RunInstanceSummary,
  type TenantMember,
} from './index';

export type { TenantMember, RunInstanceSummary };

export interface UseTenantMembersParams {
  tenantId?: string | null;
}

/** Query the list of user principals in the tenant for owner-filter dropdowns. */
export function useTenantMembers(
  options: ClientOptions = {},
  params: UseTenantMembersParams = {}
): UseQueryResult<TenantMember[]> {
  return useQuery({
    queryKey: ['members', params.tenantId ?? null],
    queryFn: () => listMembers(options, params),
    enabled: params.tenantId != null,
    staleTime: 5 * 60_000,
  });
}

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

export interface UseMyRunsParams {
  tenantId?: string | null;
}

/**
 * Query the current user's own workflow run instances for the library rail.
 * Caller-scoped (per-user privacy) — distinct from {@link useLibraryResources},
 * which lists the tenant's deployment catalog.
 */
export function useMyRuns(
  options: ClientOptions = {},
  params: UseMyRunsParams = {}
): UseQueryResult<RunInstanceSummary[]> {
  return useQuery({
    queryKey: ['my-runs', params.tenantId ?? null],
    queryFn: () => listMyRuns(options, params),
    enabled: params.tenantId != null,
    refetchInterval: 5000,
  });
}

export interface UseArtifactsParams {
  tenantId?: string | null;
  query?: string;
  sort?: 'newest' | 'oldest';
  kind?: string;
  status?: ArtifactStatus;
  ownerPrincipalId?: string;
  enabled?: boolean;
}

/** Query the current user's artifacts across all jobs for the gallery. */
export function useArtifacts(
  options: ClientOptions = {},
  params: UseArtifactsParams = {}
): UseQueryResult<ArtifactWithSession[]> {
  return useQuery({
    queryKey: [
      'artifacts',
      params.tenantId ?? null,
      params.query ?? '',
      params.sort ?? 'newest',
      params.kind ?? '',
      params.status ?? '',
      params.ownerPrincipalId ?? '',
    ],
    queryFn: () => listArtifacts(options, params).then((page) => page.artifacts),
    enabled: params.tenantId != null && (params.enabled ?? true),
  });
}
