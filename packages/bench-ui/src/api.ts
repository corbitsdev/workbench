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
    throw new BenchApiError(`Not signed in for ${path}.`, 401);
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

export function createBench(input: CreateBenchInput): Promise<Bench> {
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
