// Every response is validated at the boundary with the platform's own
// schemas, so a shape change surfaces as an error state, never `undefined`.
// Fallback error messages name what was happening, never the raw route.

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

const CardinalErrorEnvelope = type({
  error: { code: "string", userMessage: "string", "refId?": "string" },
});

const StockErrorEnvelope = type({
  error: { code: "string", message: "string" },
});

// The hub's own envelope `userMessage` (or stock `message`) wins when
// present, otherwise a generic, path-free sentence.
export function readErrorEnvelope(status: number, body: unknown, verb?: string): string {
  const cardinal = CardinalErrorEnvelope(body);
  if (!(cardinal instanceof type.errors)) {
    return cardinal.error.userMessage;
  }
  const stock = StockErrorEnvelope(body);
  if (!(stock instanceof type.errors)) {
    return stock.error.message;
  }
  return verb !== undefined && verb.length > 0
    ? `The server answered ${status} while ${verb}.`
    : `The server answered ${status}.`;
}

export type Validator<T> = (data: unknown) => T | ArkErrors;

export type ApiErrorCtor = new (message: string, status?: number, path?: string) => Error;

// Exported (not `typeof fetch`) so a bound server-side wrapper — which never
// carries `fetch`'s static `preconnect` member — satisfies the type too.
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function defaultHeaders(init?: RequestInit): HeadersInit {
  const hasBody = init?.body !== undefined;
  return {
    accept: "application/json",
    ...(hasBody || init?.method !== undefined ? { "content-type": "application/json" } : {}),
    ...init?.headers,
  };
}

export async function apiRequest<T>(
  path: string,
  schema: Validator<T>,
  verb?: string,
  ErrorCtor: ApiErrorCtor = ApiQueryError,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch,
  options?: { readonly throwUnauthenticatedOn401?: boolean },
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      headers: defaultHeaders(init),
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause), undefined, path);
  }
  if (response.status === 401 && options?.throwUnauthenticatedOn401 === true) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status, path);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    const prefix =
      verb !== undefined && verb.length > 0
        ? `Unexpected response shape while ${verb}`
        : "Unexpected response shape";
    throw new ErrorCtor(`${prefix}: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

/** For a route whose success response is `204 No Content` — nothing to
 * validate against a schema, so this is the one place a call is allowed
 * to end without a parsed body, rather than every `request<T>` caller
 * having to accept an unsound `undefined as T`. */
export async function requestVoid(
  path: string,
  verb?: string,
  ErrorCtor: ApiErrorCtor = ApiQueryError,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch,
  options?: { readonly throwUnauthenticatedOn401?: boolean },
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause), undefined, path);
  }
  if (response.status === 401 && options?.throwUnauthenticatedOn401 === true) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status, path);
  }
  // A void route answers `204 No Content` by contract. Any other 2xx (e.g.
  // a 200/201-with-body a route drifted into returning where 204 is expected)
  // is a contract mismatch and must fail loudly rather than be silently
  // accepted as an empty success.
  if (response.status !== 204) {
    const label = verb !== undefined && verb.length > 0 ? `while ${verb}` : `for ${path}`;
    throw new ErrorCtor(
      `Unexpected response ${label}: expected 204 No Content, got ${response.status}`,
      response.status,
      path,
    );
  }
}

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

/** The key and fetcher `useAPIQuery` runs, for callers that batch reads with
 * `useQueries` and must share the same cache entry. */
export function apiQueryOptions<T>(path: string, schema: Validator<T>) {
  return {
    queryKey: pathToQueryKey(path),
    queryFn: (): Promise<T> =>
      apiRequest(path, schema, undefined, ApiQueryError, undefined, fetch, {
        throwUnauthenticatedOn401: true,
      }),
  };
}

// Pass a module-level schema so identity stays stable. Empty paths are
// disabled and never fetch, so a call site with an unresolved tenant
// can't hit the network with a broken URL.
export function useAPIQuery<T>(
  path: string,
  schema: Validator<T>,
  options?: { readonly refetchInterval?: number | false },
): APIQuery<T> {
  const result = useQuery({
    ...apiQueryOptions(path, schema),
    enabled: path !== "",
    ...(options?.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
  return toAPIQuery(result);
}

// Loud on a non-2xx status or a shape mismatch, never a silent fallback.
function postJSON<T>(path: string, schema: Validator<T>, body: unknown): Promise<T> {
  return apiRequest(path, schema, undefined, ApiQueryError, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Approves a pending approval. Scope "always" is the stock standing
 * approval: the run's grant for this tool becomes allow. */
export function approveApproval(
  tenantId: string,
  approvalId: string,
  scope: "once" | "always" = "once",
): Promise<Approval> {
  return postJSON(`/api/tenants/${tenantId}/approvals/${approvalId}/approve`, ApprovalResponse, {
    scope,
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
export function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  return apiRequest(
    `/api/tenants/${encodeURIComponent(tenantId)}`,
    TenantDetailSchema,
    "loading tenant detail",
    ApiQueryError,
    undefined,
    fetch,
    { throwUnauthenticatedOn401: true },
  );
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
  const parsed = await apiRequest(
    `/api/tenants/${tenantId}/artifacts/${encodeURIComponent(artifactId)}`,
    ArtifactDetailSchema,
    "loading artifact detail",
    ApiQueryError,
    undefined,
    fetch,
    { throwUnauthenticatedOn401: true },
  );
  return parsed.artifact;
}
