// Client for the workflow-run-authenticated counterpart of the native
// Interchange tenant routes (`@intx/hub-api`: `createPrincipalRoutes`,
// `createGrantRoutes`) — see `./routes.ts`, mounted at
// `/api/workflow-access`. Same auth-header shape, same error-handling,
// same arktype-response-parsing pattern as every other tool bundle's
// `client.ts` in this codebase (`@corbits/agent-directory-tools`,
// `@corbits/capability-tools`); only the base path differs.
//
// Every request and response speaks the native Interchange contract:
// `{data, nextCursor}` pages for `GET /principals` and `GET /grants`,
// one single-action `POST /grants` body per grant (returning the single
// `GrantResponse` object), `DELETE /grants/:grantId` returning `204`, and
// the canonical `{error: {code, message}}` envelope on failures
// (`AccessForbiddenError` / `AccessNotFoundError` surface the hub's
// `message` verbatim so Myra can act on it).
import { type } from "arktype";

export interface AccessToolClientConfig {
  readonly hubAccessUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface ListedPrincipal {
  readonly id: string;
  readonly kind: "user" | "agent" | "workflow";
  readonly refId: string;
  readonly status: "active" | "suspended" | "invited" | "deactivated";
}

export interface ListedGrant {
  readonly id: string;
  readonly principalId: string | null;
  readonly resource: string;
  readonly action: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface GrantAccessRequest {
  readonly principalId: string;
  readonly resource: string;
  readonly actions: readonly string[];
}

function authHeaders(config: AccessToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.message` out of the canonical hub envelope
 * (`{error: {code, message}}`, per `errorResponse` in
 * `@intx/hub-common/errors`), if `body` matches that shape. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  const message = (error as { message: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export class AccessForbiddenError extends Error {
  override readonly name = "AccessForbiddenError";
}

export class AccessNotFoundError extends Error {
  override readonly name = "AccessNotFoundError";
}

async function throwForStatus(
  operation: string,
  response: Response,
): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const message = errorMessageFrom(body) ?? response.statusText;
  if (response.status === 403) {
    throw new AccessForbiddenError(`${operation} failed: ${message}`);
  }
  if (response.status === 404) {
    throw new AccessNotFoundError(`${operation} failed: ${message}`);
  }
  throw new Error(`${operation} failed: ${message}`);
}

const ListedPrincipalsResponse = type({
  data: type({
    id: "string",
    kind: "'user' | 'agent' | 'workflow'",
    refId: "string",
    status: "'active' | 'suspended' | 'invited' | 'deactivated'",
  }).array(),
  "nextCursor?": "string | null",
});

const ListedGrantsResponse = type({
  data: type({
    id: "string",
    "principalId?": "string | null",
    resource: "string",
    action: "string",
    effect: "'allow' | 'deny' | 'ask'",
  }).array(),
  "nextCursor?": "string | null",
});

const CreatedGrantResponse = type({
  id: "string",
  "principalId?": "string | null",
  resource: "string",
  action: "string",
  effect: "'allow' | 'deny' | 'ask'",
});

/** Lists every principal in the run's tenant, following the native
 * `nextCursor` pages to the end — Myra needs the full list to find the
 * agent she just created before granting it access. */
export async function listPrincipals(
  config: AccessToolClientConfig,
): Promise<ListedPrincipal[]> {
  const fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  const principals: ListedPrincipal[] = [];
  let cursor: string | null | undefined;
  do {
    const url =
      cursor === undefined || cursor === null
        ? `${config.hubAccessUrl}/principals`
        : `${config.hubAccessUrl}/principals?cursor=${encodeURIComponent(cursor)}`;
    const response = await fetchImpl(url, {
      headers: { ...authHeaders(config) },
    });
    if (!response.ok) {
      await throwForStatus("Listing principals", response);
    }
    const body: unknown = await response.json();
    const parsed = ListedPrincipalsResponse(body);
    if (parsed instanceof type.errors) {
      throw new Error(
        `Principals response did not match the expected shape: ${parsed.summary}`,
      );
    }
    principals.push(...parsed.data);
    cursor = parsed.nextCursor ?? null;
  } while (cursor !== null);
  return principals;
}

export interface ListGrantsFilter {
  readonly principalId?: string;
  readonly resource?: string;
  readonly action?: string;
}

/** Lists grants in the run's tenant, passing the given filters through as
 * the native `GET /grants` query params (`principalId`, `resource`,
 * `action`). */
export async function listGrants(
  config: AccessToolClientConfig,
  filter?: ListGrantsFilter,
): Promise<ListedGrant[]> {
  const fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  const params = new URLSearchParams();
  if (filter?.principalId !== undefined)
    params.set("principalId", filter.principalId);
  if (filter?.resource !== undefined) params.set("resource", filter.resource);
  if (filter?.action !== undefined) params.set("action", filter.action);
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await fetchImpl(`${config.hubAccessUrl}/grants${query}`, {
    headers: { ...authHeaders(config) },
  });
  if (!response.ok) {
    await throwForStatus("Listing grants", response);
  }
  const body: unknown = await response.json();
  const parsed = ListedGrantsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `List-grants response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Grants access by posting one native single-action `POST /grants` body
 * per requested action — `effect: "allow"`, `origin: "invoker"` — and
 * parsing each single `GrantResponse` object the hub returns. */
export async function grantAccess(
  config: AccessToolClientConfig,
  request: GrantAccessRequest,
): Promise<ListedGrant[]> {
  const fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  const created: ListedGrant[] = [];
  for (const action of request.actions) {
    const response = await fetchImpl(`${config.hubAccessUrl}/grants`, {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        principalId: request.principalId,
        resource: request.resource,
        action,
        effect: "allow",
        origin: "invoker",
      }),
    });
    if (!response.ok) {
      await throwForStatus("Granting access", response);
    }
    const body: unknown = await response.json();
    const parsed = CreatedGrantResponse(body);
    if (parsed instanceof type.errors) {
      throw new Error(
        `Grant-access response did not match the expected shape: ${parsed.summary}`,
      );
    }
    created.push(parsed);
  }
  return created;
}

/** Revokes the grant with the given id. The native
 * `DELETE /grants/:grantId` returns `204` with no body, so success is the
 * absence of a throw. */
export async function revokeAccess(
  config: AccessToolClientConfig,
  grantId: string,
): Promise<void> {
  const fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  const response = await fetchImpl(
    `${config.hubAccessUrl}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE", headers: { ...authHeaders(config) } },
  );
  if (!response.ok) {
    await throwForStatus("Revoking access", response);
  }
}
