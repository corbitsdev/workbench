// The interface's one seam to the hub: relative /api paths on the origin the
// bundle was served from, validated at the boundary with the platform's own
// response schemas so a shape change surfaces as an error state, never as
// undefined leaking into a page.

import {
  ApprovalResponse,
  AssetWithOriginResponse,
  PrincipalSummary,
  UserProfile,
  WorkflowRunSummary,
  paginatedSchema,
} from "@intx/types";
import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";
import { pathToQueryKey } from "./query-client";

export const ProfileSchema = UserProfile;
export const PrincipalsSchema = paginatedSchema(PrincipalSummary);
export const TenantApprovalsSchema = paginatedSchema(ApprovalResponse);

// `GET /api/tenants/:tenantId/assets` returns a bare array of
// `AssetWithOriginResponse` rows (not the paginated envelope), so the schema
// validates the array directly. These tenant assets — workflows, skills,
// package registries, agent state — are the real, listable store the Library
// page renders as artifacts.
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
  ownerName: "string | null",
  archivedAt: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export const ArtifactListPageSchema = type({
  data: ArtifactListItemSchema.array(),
  nextCursor: "string | null",
});
export const ArtifactDetailSchema = ArtifactListItemSchema.merge(
  type({
    content: "string",
  }),
);
export const ArtifactUploadResponseSchema = type({
  data: ArtifactDetailSchema.array(),
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
export type WorkflowRun = typeof WorkflowRunSummary.infer;
export type Approval = typeof ApprovalResponse.infer;
export type AssetRow = typeof AssetWithOriginResponse.infer;
export type ArtifactListItem = typeof ArtifactListItemSchema.infer;
export type ArtifactListPage = typeof ArtifactListPageSchema.infer;
export type ArtifactDetail = typeof ArtifactDetailSchema.infer;
export type ArtifactCounts = typeof ArtifactCountsSchema.infer;
/**
 * The envelope paginatedSchema validates, stated structurally: the generic
 * schema's inferred type carries an arktype inference artifact that rejects
 * plain literals, so pages and tests use this equivalent shape instead.
 */
type Paginated<T> = { data: T[]; nextCursor: string | null };
export type PrincipalsPage = Paginated<Principal>;

/** An arktype schema, seen as the validating call every `Type` provides. */
type Validator<T> = (data: unknown) => T | ArkErrors;

/**
 * Fetches one hub endpoint and reports exactly what happened: loading, no
 * session (401), a failure, or validated data. Pass a module-level schema so
 * identity stays stable; the schema never enters the query key.
 *
 * Empty paths are disabled and never fetch — the boundary owns the gate so
 * call sites that still pass `""` when a tenant is unresolved cannot hit
 * the network with a broken URL.
 */
export function useAPIQuery<T>(
  path: string,
  schema: Validator<T>,
): APIQuery<T> {
  const enabled = path !== "";
  const result = useQuery({
    queryKey: pathToQueryKey(path),
    enabled,
    queryFn: async () => {
      const response = await fetch(path, {
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        throw new UnauthenticatedError();
      }
      if (!response.ok) {
        throw new ApiQueryError(
          `The server answered ${response.status}.`,
          response.status,
          path,
        );
      }
      const parsed = schema(await response.json());
      if (parsed instanceof type.errors) {
        throw new ApiQueryError(
          `Unexpected response shape: ${parsed.summary}`,
          undefined,
          path,
        );
      }
      return parsed;
    },
  });
  return toAPIQuery(result);
}

/**
 * A one-shot POST against a hub route, parsed the same way `useAPIQuery`
 * parses its GETs: loud on a non-2xx status and on a response shape that
 * doesn't match the schema, never a silent fallback.
 */
async function postJSON<T>(
  path: string,
  schema: Validator<T>,
  body: unknown,
): Promise<T> {
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
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      path,
    );
  }
  const parsed = schema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

/** Approves a pending approval. Scope is always "once": the hub rejects
 * "always" with a 400 (see `vendor/intx/hub-api/src/routes/approvals.ts`),
 * so this surface never offers it. */
export function approveApproval(
  tenantId: string,
  approvalId: string,
): Promise<Approval> {
  return postJSON(
    `/api/tenants/${tenantId}/approvals/${approvalId}/approve`,
    ApprovalResponse,
    { scope: "once" },
  );
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

/**
 * Sandboxed HTML preview URL for a Library artifact (CL-5879) — the same
 * path an `<iframe sandbox>` in the canvas or Library detail pane loads,
 * and the "Open in new tab" affordance's `href`. Server-side (`GET
 * .../artifacts/:id/preview` in `@corbits/artifacts-hub`) answers 415 for
 * a non-HTML artifact.
 */
export function artifactPreviewPath(
  tenantId: string,
  artifactId: string,
): string {
  return `/api/tenants/${tenantId}/artifacts/${encodeURIComponent(artifactId)}/preview`;
}

/**
 * One-shot fetch of a Library artifact's detail — the same
 * `GET /api/tenants/:id/artifacts/:artifactId` read `LibraryRoute` uses via
 * `useAPIQuery`, but as a plain promise for callers that aren't a mounted
 * component (a chat artifact chip's open handler). Never falls back to
 * blob bytes: an `artifactId` always resolves through this Library read.
 */
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
    throw new ApiQueryError(
      `Unexpected artifact response shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
