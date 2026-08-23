// The one HTTP seam this package still owns: asking which of the caller's
// tenant ids are workbench child tenancies. Member/invite/create clients
// lived here while the dead switcher and MembersPanel did; those UIs are
// gone (creation is `/new`, people management is settings-ui's PeopleSection),
// so the orphan invite/create/list clients went with them.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { PrincipalSummary } from "@intx/types";
import { UnauthenticatedError } from "@corbits/api-query";

export type BenchMembership = typeof PrincipalSummary.infer;

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

const WorkbenchTenantIds = type({
  workbenchTenantIds: "string[]",
});

/** Which of `tenantIds` are workbench child tenancies rather than
 * workbenches — the one fact `/api/me/principals` cannot answer, since
 * a native tenant row carries no kind marker (see `./tenancy-kind.ts`).
 * An empty input never round-trips: there is nothing to ask. */
export function listWorkbenchTenantIds(
  tenantIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (tenantIds.length === 0) return Promise.resolve(new Set());
  return request("/api/workbench-tenancies/kinds", WorkbenchTenantIds, {
    method: "POST",
    body: JSON.stringify({ tenantIds }),
  }).then((body) => new Set(body.workbenchTenantIds));
}
