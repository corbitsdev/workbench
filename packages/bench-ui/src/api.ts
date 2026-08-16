// The bench surface's one seam to Interchange's native tenancy routes
// (see vendor/intx/hub-api/src/routes/tenants.ts and principals.ts). Every
// fetch the bench/* components make goes through a function here, and every
// response is parsed with an arktype schema from `@intx/types` — the one
// real wire contract, never a hand-copied second one — at the boundary.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import {
  PrincipalResponse,
  PrincipalSummary,
  TenantResponse,
  paginatedSchema,
} from "@intx/types";
import { UnauthenticatedError } from "@corbits/api-query";
import { getBenchSettings, patchBenchSettings } from "@corbits/bench/client";
import type {
  BenchSettingsPatch,
  BenchSettingsResponse,
} from "@corbits/bench/client";

// Purpose and type aren't part of Interchange's native tenant shape (see
// this file's header note), so they come from `@corbits/bench`'s own
// side-table client — re-exported here rather than imported directly by
// components, so `bench-ui`'s components keep this one seam.
export { getBenchSettings, patchBenchSettings };
export type { BenchSettingsPatch, BenchSettingsResponse };

export type BenchMembership = typeof PrincipalSummary.infer;
export type BenchMember = typeof PrincipalResponse.infer;
export type Bench = typeof TenantResponse.infer;

const MembershipsPage = paginatedSchema(PrincipalSummary);
const MembersPage = paginatedSchema(PrincipalResponse);

export class BenchApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new BenchApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new BenchApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new BenchApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** The caller's own memberships, one row per bench they belong to. Only the
 * first page — a person on more than a page of benches is not a case this
 * surface handles yet, matching the same simplification `apps/web`'s
 * settings page already makes over this same endpoint. */
export function listMyMemberships(): Promise<readonly BenchMembership[]> {
  return request("/api/me/principals", MembershipsPage).then(
    (page) => page.data,
  );
}

export type CreateBenchInput = {
  readonly name: string;
  readonly slug: string;
  readonly parentId?: string;
};

/**
 * Creates a bench. A `parentId` (creating a sub-workbench under an
 * existing one) routes through `@workbench/access-policy`'s gated
 * surface instead of the native route directly — that surface checks
 * the parent's own `tenancyCreation` policy against the caller's roles
 * before ever calling `POST /api/tenants` itself. A bare top-level
 * bench (no `parentId`) is unaffected and still hits the native route.
 */
export function createBench(input: CreateBenchInput): Promise<Bench> {
  if (input.parentId !== undefined) {
    return request(
      `/api/tenants/${input.parentId}/access-policy/child-tenants`,
      TenantResponse,
      {
        method: "POST",
        body: JSON.stringify({ name: input.name, slug: input.slug }),
      },
    );
  }
  return request("/api/tenants", TenantResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Every member of one bench. Only the first page, same simplification as
 * `listMyMemberships`. */
export function listMembers(tenantId: string): Promise<readonly BenchMember[]> {
  return request(`/api/tenants/${tenantId}/principals`, MembersPage).then(
    (page) => page.data,
  );
}

export function inviteMember(
  tenantId: string,
  email: string,
): Promise<BenchMember> {
  return request(`/api/tenants/${tenantId}/members/invite`, PrincipalResponse, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

const ChannelTenantIds = type({
  channelTenantIds: "string[]",
});

/** Which of `tenantIds` are channel child tenancies rather than
 * workbenches — the one fact `/api/me/principals` cannot answer, since
 * a native tenant row carries no kind marker (see `./tenancy-kind.ts`).
 * An empty input never round-trips: there is nothing to ask. */
export function listChannelTenantIds(
  tenantIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (tenantIds.length === 0) return Promise.resolve(new Set());
  return request("/api/channel-tenancies/kinds", ChannelTenantIds, {
    method: "POST",
    body: JSON.stringify({ tenantIds }),
  }).then((body) => new Set(body.channelTenantIds));
}
