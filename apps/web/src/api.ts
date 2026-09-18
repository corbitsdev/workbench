// Every response is validated at the boundary with the platform's own
// schemas, so a shape change surfaces as an error state, never `undefined`.

import {
  ApprovalResponse,
  AssetWithOriginResponse,
  PrincipalSummary,
  TenantResponse,
  UserProfile,
  WorkflowRunSummary,
  paginatedSchema,
} from "@intx/types";
import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import type { APIQuery } from "@/lib/api-query";
import { ApiQueryError, UnauthenticatedError, toAPIQuery } from "@/lib/api-query";
import { pathToQueryKey } from "./query-client";

export const ProfileSchema = UserProfile;
export const PrincipalsSchema = paginatedSchema(PrincipalSummary);
export const TenantApprovalsSchema = paginatedSchema(ApprovalResponse);
export const TenantDetailSchema = TenantResponse;

// Returns a bare array, not the paginated envelope, so this validates the
// array directly.
export const AssetsSchema = AssetWithOriginResponse.array();

// Real Library plane: paginated list from GET /api/tenants/:id/artifacts.
// Content is intentionally omitted on list; detail fetches include it.
export const ArtifactListItemSchema = type({
  id: "string",
  kind: "string",
  title: "string",
  source: "Record<string, unknown>",
  version: "number",
  ownerPrincipalId: "string | null",
  metadata: "Record<string, unknown> | null",
  archivedAt: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export const ArtifactListPageSchema = type({
  artifacts: ArtifactListItemSchema.array(),
  nextCursor: "string | null",
});
export const ArtifactRowSchema = ArtifactListItemSchema.merge(
  type({
    content: "string",
  }),
);
export const ArtifactDetailSchema = type({
  artifact: ArtifactRowSchema,
});
export const ArtifactUploadResponseSchema = type({
  artifacts: ArtifactRowSchema.array(),
});

// GET /api/tenants/:id/artifacts/counts — honest per-kind-segment counts
// over the tenant's full artifact list, computed by the hub so the Library
// nav never shows a number the page itself couldn't otherwise prove.
export const ArtifactCountsSchema = type({
  all: "number",
  document: "number",
  sheet: "number",
  pdf: "number",
  routine: "number",
});

export type Profile = typeof UserProfile.infer;
export type Principal = typeof PrincipalSummary.infer;
export type TenantDetail = typeof TenantResponse.infer;
export type WorkflowRun = typeof WorkflowRunSummary.infer;
export type Approval = typeof ApprovalResponse.infer;
export type AssetRow = typeof AssetWithOriginResponse.infer;
export type ArtifactListItem = typeof ArtifactListItemSchema.infer;
export type ArtifactListPage = typeof ArtifactListPageSchema.infer;
export type ArtifactDetail = typeof ArtifactRowSchema.infer;
export type ArtifactCounts = typeof ArtifactCountsSchema.infer;
// Stated structurally because the generic schema's inferred type rejects
// plain literals.
type Paginated<T> = { data: T[]; nextCursor: string | null };
export type PrincipalsPage = Paginated<Principal>;

/** An arktype schema, seen as the validating call every `Type` provides. */
type Validator<T> = (data: unknown) => T | ArkErrors;

// Pass a module-level schema so identity stays stable. Empty paths are
// disabled and never fetch, so a call site with an unresolved tenant
// can't hit the network with a broken URL.
export function useAPIQuery<T>(
  path: string,
  schema: Validator<T>,
  options?: { readonly refetchInterval?: number | false },
): APIQuery<T> {
  const enabled = path !== "";
  const result = useQuery({
    queryKey: pathToQueryKey(path),
    enabled,
    ...(options?.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
    queryFn: async () => {
      const response = await fetch(path, {
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        throw new UnauthenticatedError();
      }
      if (!response.ok) {
        throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
      }
      const parsed = schema(await response.json());
      if (parsed instanceof type.errors) {
        throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
      }
      return parsed;
    },
  });
  return toAPIQuery(result);
}

// Loud on a non-2xx status or a shape mismatch, never a silent fallback.
async function postJSON<T>(path: string, schema: Validator<T>, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = schema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

/** Approves a pending approval. Scope is always "once": the hub rejects
 * "always" with a 400 (see `vendor/intx/hub-api/src/routes/approvals.ts`),
 * so this surface never offers it. */
export function approveApproval(tenantId: string, approvalId: string): Promise<Approval> {
  return postJSON(`/api/tenants/${tenantId}/approvals/${approvalId}/approve`, ApprovalResponse, {
    scope: "once",
  });
}

export function rejectApproval(
  tenantId: string,
  approvalId: string,
  message?: string,
): Promise<Approval> {
  return postJSON(
    `/api/tenants/${tenantId}/approvals/${approvalId}/reject`,
    ApprovalResponse,
    message === undefined ? {} : { message },
  );
}

// The only place `parentId` comes from — a bench is a top-level tenant,
// so a raw-id/name heuristic can never tell it apart from a workbench.
export async function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      `tenant ${tenantId}`,
    );
  }
  const parsed = TenantDetailSchema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected tenant response shape: ${parsed.summary}`);
  }
  return parsed;
}

// The server answers 415 for a non-HTML artifact.
export function artifactPreviewPath(tenantId: string, artifactId: string): string {
  return `/api/tenants/${tenantId}/artifacts/${encodeURIComponent(artifactId)}/preview`;
}

// A plain promise for callers that aren't a mounted component. Never
// falls back to blob bytes: an `artifactId` always resolves through here.
export async function fetchArtifactDetail(
  tenantId: string,
  artifactId: string,
): Promise<ArtifactDetail> {
  const response = await fetch(
    `/api/tenants/${tenantId}/artifacts/${encodeURIComponent(artifactId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      `artifact ${artifactId}`,
    );
  }
  const parsed = ArtifactDetailSchema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected artifact response shape: ${parsed.summary}`);
  }
  return parsed.artifact;
}
