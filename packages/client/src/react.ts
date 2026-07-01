// @workbench/client/react — TanStack Query hooks built on the root data-access
// functions. React and @tanstack/react-query are peer dependencies; the host
// app provides the QueryClientProvider.

import {
  useMutation,
  useQueryClient,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  Artifact,
  ArtifactStatus,
  ArtifactWithSession,
  WorkflowSummary,
} from "@workbench/shared";
import {
  createArtifact,
  listArtifacts,
  listWorkflows,
  listMembers,
  uploadArtifacts,
  type ClientOptions,
  type CreateArtifactParams,
  type TenantMember,
  type UploadArtifactsParams,
} from "./index";

export type { TenantMember };

// The Use*Params shapes below are internal, already-trusted hook inputs
// (props-like) — never parsed from an untrusted boundary. Per the repo arktype
// policy they stay plain; the serialized request shapes they feed live as
// exported arktype schemas in ./index.
export interface UseTenantMembersParams {
  tenantId?: string | null;
}

/** Query the list of user principals in the tenant for owner-filter dropdowns. */
export function useTenantMembers(
  options: ClientOptions = {},
  params: UseTenantMembersParams = {},
): UseQueryResult<TenantMember[]> {
  return useQuery({
    queryKey: ["members", params.tenantId ?? null],
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
  params: UseLibraryResourcesParams = {},
): UseQueryResult<WorkflowSummary[]> {
  return useQuery({
    queryKey: ["workflows", params.tenantId ?? null],
    queryFn: () => listWorkflows(options, params),
    enabled: params.tenantId != null,
    refetchInterval: 5000,
  });
}

export interface UseArtifactsParams {
  tenantId?: string | null;
  query?: string;
  sort?: "newest" | "oldest";
  kind?: string;
  status?: ArtifactStatus;
  ownerPrincipalId?: string;
  createdAfter?: string;
  createdBefore?: string;
  enabled?: boolean;
}

/** Query the current user's artifacts across all jobs for the gallery. */
export function useArtifacts(
  options: ClientOptions = {},
  params: UseArtifactsParams = {},
): UseQueryResult<ArtifactWithSession[]> {
  return useQuery({
    queryKey: [
      "artifacts",
      params.tenantId ?? null,
      params.query ?? "",
      params.sort ?? "newest",
      params.kind ?? "",
      params.status ?? "",
      params.ownerPrincipalId ?? "",
      params.createdAfter ?? "",
      params.createdBefore ?? "",
    ],
    queryFn: () =>
      listArtifacts(options, params).then((page) => page.artifacts),
    enabled: params.tenantId != null && (params.enabled ?? true),
  });
}

/**
 * Create an artifact from an external source and refresh the gallery. Callers
 * must `.catch()` the returned `mutateAsync` (or use `mutate` with `onError`).
 */
export function useCreateArtifact(
  options: ClientOptions = {},
): UseMutationResult<Artifact, Error, CreateArtifactParams> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateArtifactParams) =>
      createArtifact(options, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
}

/**
 * Import one or more files as artifacts and refresh the gallery. Callers must
 * `.catch()` the returned `mutateAsync` (or use `mutate` with `onError`).
 */
export function useUploadArtifacts(
  options: ClientOptions = {},
): UseMutationResult<Artifact[], Error, UploadArtifactsParams> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: UploadArtifactsParams) =>
      uploadArtifacts(options, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
}
