// @workbench/client/react — TanStack Query hooks built on the root data-access
// functions. React and @tanstack/react-query are peer dependencies; the host
// app provides the QueryClientProvider.

import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  Artifact,
  ArtifactWithSession,
  WorkflowSummary,
} from "@workbench/shared";
import {
  archiveArtifact,
  createArtifact,
  getArtifact,
  listArtifacts,
  listWorkflows,
  listMembers,
  unarchiveArtifact,
  uploadArtifacts,
  type ArtifactsPage,
  type ClientOptions,
  type ListArtifactsParams,
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
  ownerPrincipalId?: string;
  creatorKind?: "user" | "agent";
  createdAfter?: string;
  createdBefore?: string;
  /** When true, list only archived artifacts (the Archived view). */
  archived?: boolean;
  enabled?: boolean;
}

/** TanStack query key for single-page `useArtifacts` (filters only; no cursor). */
export function artifactsListQueryKey(
  params: Omit<UseArtifactsParams, "enabled"> = {},
): readonly unknown[] {
  return [
    "artifacts",
    params.tenantId ?? null,
    params.query ?? "",
    params.sort ?? "newest",
    params.kind ?? "",
    params.ownerPrincipalId ?? "",
    params.creatorKind ?? "",
    params.createdAfter ?? "",
    params.createdBefore ?? "",
    params.archived ?? false,
  ] as const;
}

/** Query key for `useArtifactsInfinite` — same filters as `artifactsListQueryKey` plus scope. */
export function artifactsInfiniteQueryKey(
  params: Omit<UseArtifactsParams, "enabled"> = {},
): readonly unknown[] {
  return [...artifactsListQueryKey(params), "infinite"] as const;
}

function listArtifactsParams(
  params: UseArtifactsParams,
  cursor?: string,
): ListArtifactsParams {
  const out: ListArtifactsParams = {};
  if (params.tenantId !== undefined) out.tenantId = params.tenantId;
  if (params.query !== undefined) out.query = params.query;
  if (params.sort !== undefined) out.sort = params.sort;
  if (params.kind !== undefined) out.kind = params.kind;
  if (params.ownerPrincipalId !== undefined) {
    out.ownerPrincipalId = params.ownerPrincipalId;
  }
  if (params.creatorKind !== undefined) out.creatorKind = params.creatorKind;
  if (params.createdAfter !== undefined) out.createdAfter = params.createdAfter;
  if (params.createdBefore !== undefined) {
    out.createdBefore = params.createdBefore;
  }
  if (params.archived !== undefined) out.archived = params.archived;
  if (cursor !== undefined) out.cursor = cursor;
  return out;
}

function getArtifactParams(params: Pick<UseArtifactParams, "tenantId">): {
  tenantId?: string | null;
} {
  const out: { tenantId?: string | null } = {};
  if (params.tenantId !== undefined) out.tenantId = params.tenantId;
  return out;
}

export type UseArtifactParams = {
  tenantId?: string | null;
  artifactId?: string;
  enabled?: boolean;
};

/** Load one artifact by id for detail views and deep links. */
export function useArtifact(
  options: ClientOptions = {},
  params: UseArtifactParams = {},
): UseQueryResult<ArtifactWithSession> {
  const artifactId = params.artifactId ?? "";
  return useQuery({
    queryKey: ["artifacts", "detail", params.tenantId ?? null, artifactId],
    queryFn: () => getArtifact(options, artifactId, getArtifactParams(params)),
    enabled:
      params.tenantId != null &&
      artifactId.length > 0 &&
      (params.enabled ?? true),
  });
}

/** Query the current user's artifacts across all jobs for the gallery. */
export function useArtifacts(
  options: ClientOptions = {},
  params: UseArtifactsParams = {},
): UseQueryResult<ArtifactWithSession[]> {
  return useQuery({
    queryKey: artifactsListQueryKey(params),
    queryFn: () =>
      listArtifacts(options, listArtifactsParams(params)).then(
        (page) => page.artifacts,
      ),
    enabled: params.tenantId != null && (params.enabled ?? true),
  });
}

export type UseArtifactsInfiniteResult = UseInfiniteQueryResult<
  InfiniteData<ArtifactsPage, string | null>,
  Error
> & {
  artifacts: ArtifactWithSession[];
};

/**
 * Cursor-paginated artifact list for the gallery (`GET /artifacts` pages).
 * Flattens loaded pages into `artifacts`; call `fetchNextPage` while `hasNextPage`.
 */
export function useArtifactsInfinite(
  options: ClientOptions = {},
  params: UseArtifactsParams = {},
): UseArtifactsInfiniteResult {
  const query = useInfiniteQuery<
    ArtifactsPage,
    Error,
    InfiniteData<ArtifactsPage, string | null>,
    ReturnType<typeof artifactsInfiniteQueryKey>,
    string | null
  >({
    queryKey: artifactsInfiniteQueryKey(params),
    queryFn: ({ pageParam }) =>
      listArtifacts(
        options,
        listArtifactsParams(params, pageParam === null ? undefined : pageParam),
      ),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: params.tenantId != null && (params.enabled ?? true),
  });

  const artifacts = useMemo(
    () => query.data?.pages.flatMap((page) => page.artifacts) ?? [],
    [query.data],
  );

  return { ...query, artifacts };
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

/** Variables for the archive/unarchive mutations. */
export interface ArchiveArtifactVars {
  artifactId: string;
  tenantId?: string | null;
}

/**
 * Archive (soft-hide) an artifact and refresh the gallery + its detail view.
 * Both the list/infinite `["artifacts", ...]` keys and the detail key are
 * invalidated so the archived row drops out everywhere. Callers must `.catch()`
 * the returned `mutateAsync` (or use `mutate` with `onError`).
 */
export function useArchiveArtifact(
  options: ClientOptions = {},
): UseMutationResult<ArtifactWithSession, Error, ArchiveArtifactVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: ArchiveArtifactVars) =>
      archiveArtifact(
        options,
        vars.artifactId,
        vars.tenantId != null ? { tenantId: vars.tenantId } : {},
      ),
    onSuccess: () => {
      // Prefix match: invalidating ["artifacts"] also refreshes every
      // ["artifacts", "detail", ...] entry, so no separate detail invalidation.
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
}

/**
 * Unarchive an artifact and refresh the gallery + its detail view. Callers must
 * `.catch()` the returned `mutateAsync` (or use `mutate` with `onError`).
 */
export function useUnarchiveArtifact(
  options: ClientOptions = {},
): UseMutationResult<ArtifactWithSession, Error, ArchiveArtifactVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: ArchiveArtifactVars) =>
      unarchiveArtifact(
        options,
        vars.artifactId,
        vars.tenantId != null ? { tenantId: vars.tenantId } : {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
}
