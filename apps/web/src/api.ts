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

import { UnauthenticatedError, pathToQueryKey } from "./query-client";

export const ProfileSchema = UserProfile;
export const PrincipalsSchema = paginatedSchema(PrincipalSummary);
export const RunsSchema = paginatedSchema(WorkflowRunSummary);
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

// `@corbits/approvals`'s "needs you" read: the same pending approvals as
// `TenantApprovalsSchema`, but with the agent and bench names already
// resolved server-side, so nothing here ever needs a raw id to render.
export const NeedsYouSchema = type({
  items: type({
    id: "string",
    agentName: "string",
    benchName: "string",
    headline: "string",
    arguments: "object",
    status: '"pending"',
    createdAt: "string.date.iso",
  }).array(),
});

// The single-approval sibling of `NeedsYouSchema` (`@corbits/approvals`'s
// `GET .../approvals/needs-you/:approvalId`): the same display-safe
// hydration, for one id, in any status -- not just pending. This is the
// chat approve card's live status read; see `approval-actions.ts`.
export const NeedsYouDetailSchema = type({
  id: "string",
  agentName: "string",
  benchName: "string",
  headline: "string",
  arguments: "object",
  status: "'pending' | 'approved' | 'rejected' | 'timeout' | 'expired'",
  createdAt: "string.date.iso",
});
export type NeedsYouDetail = typeof NeedsYouDetailSchema.infer;

export type Profile = typeof UserProfile.infer;
export type Principal = typeof PrincipalSummary.infer;
export type WorkflowRun = typeof WorkflowRunSummary.infer;
export type Approval = typeof ApprovalResponse.infer;
export type AssetRow = typeof AssetWithOriginResponse.infer;
export type ArtifactListItem = typeof ArtifactListItemSchema.infer;
export type ArtifactListPage = typeof ArtifactListPageSchema.infer;
export type ArtifactDetail = typeof ArtifactDetailSchema.infer;
export type ArtifactCounts = typeof ArtifactCountsSchema.infer;
export type NeedsYou = typeof NeedsYouSchema.infer;
export type NeedsYouItem = NeedsYou["items"][number];

/**
 * How many things need this bench's attention right now — the count the
 * second column's "Approvals" row badges. `null` while unknown (no bench
 * selected yet, or the read hasn't resolved), so a caller never mistakes
 * "still loading" for "zero pending."
 */
export function useNeedsYouCount(tenantId: string | null): number | null {
  const query = useAPIQuery(
    tenantId === null ? "" : `/api/tenants/${tenantId}/approvals/needs-you`,
    NeedsYouSchema,
  );
  return query.kind === "ready" ? query.data.items.length : null;
}

/**
 * The envelope paginatedSchema validates, stated structurally: the generic
 * schema's inferred type carries an arktype inference artifact that rejects
 * plain literals, so pages and tests use this equivalent shape instead.
 */
type Paginated<T> = { data: T[]; nextCursor: string | null };
export type PrincipalsPage = Paginated<Principal>;
export type RunsPage = Paginated<WorkflowRun>;

export type APIQuery<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T };

/** An arktype schema, seen as the validating call every `Type` provides. */
type Validator<T> = (data: unknown) => T | ArkErrors;

/**
 * Map a TanStack Query result onto the APIQuery discriminant pages already
 * render through QueryView. `isLoading` (pending + fetching) is the loading
 * state — bare `isPending` would flash skeletons when cached data exists.
 */
export function toAPIQuery<T>(result: {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
}): APIQuery<T> {
  if (result.isLoading) return { kind: "loading" };
  if (result.isError) {
    if (result.error instanceof UnauthenticatedError) {
      return { kind: "unauthenticated" };
    }
    return {
      kind: "error",
      message:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
    };
  }
  if (result.data !== undefined) return { kind: "ready", data: result.data };
  // Disabled queries (empty path, unresolved tenant) have no data and are not
  // fetching — still report loading so callers that gate on "ready" stay quiet.
  return { kind: "loading" };
}

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
        throw new Error(`The server answered ${response.status} for ${path}.`);
      }
      const parsed = schema(await response.json());
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected response shape from ${path}: ${parsed.summary}`,
        );
      }
      return parsed;
    },
  });
  return toAPIQuery(result);
}

export class APIMutationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
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
    throw new APIMutationError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new APIMutationError(
      `The server answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const parsed = schema(await response.json());
  if (parsed instanceof type.errors) {
    throw new APIMutationError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
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

export type NeedsYouDetailResult =
  | { readonly kind: "ready"; readonly item: NeedsYouDetail }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string };

/**
 * The chat approve card's live status read: `@corbits/approvals`'s
 * single-approval "needs you" detail, in any status. A 403 here means the
 * tenant-wide read grant was refused -- deliberately coarser than the
 * native approve/reject routes' per-deployment grant, so it is not proof
 * the viewer cannot resolve this approval (see `approval-actions.ts`).
 */
export async function getApprovalNeedsYou(
  tenantId: string,
  approvalId: string,
): Promise<NeedsYouDetailResult> {
  const response = await fetch(
    `/api/tenants/${tenantId}/approvals/needs-you/${approvalId}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) {
    return {
      kind: "error",
      message: `The server answered ${response.status} for this approval.`,
    };
  }
  const parsed = NeedsYouDetailSchema(await response.json());
  if (parsed instanceof type.errors) {
    return { kind: "error", message: parsed.summary };
  }
  return { kind: "ready", item: parsed };
}
