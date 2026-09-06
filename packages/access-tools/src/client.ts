// A minimal client for `@corbits/access-tools`' own workflow-run-
// authenticated surface (`./routes.ts`, mounted at
// `/api/workflow-access`): same auth-header shape, same error-handling,
// same arktype-response-parsing pattern as every other tool bundle's
// `client.ts` in this codebase (`@corbits/agent-directory-tools`,
// `@corbits/capability-tools`).
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

/** Pulls `error.userMessage` out of the canonical hub envelope
 * (`{error: {code, userMessage, refId}}`), if `body` matches that shape. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (
    error === null ||
    typeof error !== "object" ||
    !("userMessage" in error)
  ) {
    return undefined;
  }
  const userMessage = (error as { userMessage: unknown }).userMessage;
  return typeof userMessage === "string" ? userMessage : undefined;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Thrown when the access route rejects the request as forbidden —
 * the caller's own principal has no `principal:*`/`grant:*` grant of
 * its own — distinct from a bare transport/HTTP failure, so a caller
 * can report honestly that a human must grant it access first. */
export class AccessForbiddenError extends Error {}

/** Thrown for a not-found principal/grant id, distinct from a bare
 * transport/HTTP failure. */
export class AccessNotFoundError extends Error {}

async function doRequest(
  config: AccessToolClientConfig,
  path: string,
  init: RequestInit,
  failureLabel: string,
): Promise<Response> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(`${config.hubAccessUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(config), ...(init.headers ?? {}) },
  });
  if (response.status === 403) {
    throw new AccessForbiddenError(
      await readErrorMessage(response, `${failureLabel}: forbidden`),
    );
  }
  if (response.status === 404) {
    throw new AccessNotFoundError(
      await readErrorMessage(response, `${failureLabel}: not found`),
    );
  }
  if (!response.ok) {
    throw new Error(
      `${failureLabel}: ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

const ListedPrincipalsResponse = type({
  principals: type({
    id: "string",
    kind: "'user'|'agent'|'workflow'",
    refId: "string",
    status: "'active'|'suspended'|'invited'|'deactivated'",
  }).array(),
});

export async function listPrincipals(
  config: AccessToolClientConfig,
): Promise<readonly ListedPrincipal[]> {
  const response = await doRequest(
    config,
    "/principals",
    { headers: authHeaders(config) },
    "Listing principals failed",
  );
  const body: unknown = await response.json();
  const parsed = ListedPrincipalsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `List-principals response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.principals;
}

const ListedGrantsResponse = type({
  grants: type({
    id: "string",
    principalId: "string | null",
    resource: "string",
    action: "string",
    effect: "'allow'|'deny'|'ask'",
  }).array(),
});

export interface ListGrantsFilter {
  readonly principalId?: string;
  readonly resource?: string;
}

export async function listGrants(
  config: AccessToolClientConfig,
  filter?: ListGrantsFilter,
): Promise<readonly ListedGrant[]> {
  const params = new URLSearchParams();
  if (filter?.principalId !== undefined) {
    params.set("principalId", filter.principalId);
  }
  if (filter?.resource !== undefined) params.set("resource", filter.resource);
  const query = params.toString();
  const response = await doRequest(
    config,
    `/grants${query.length > 0 ? `?${query}` : ""}`,
    { headers: authHeaders(config) },
    "Listing grants failed",
  );
  const body: unknown = await response.json();
  const parsed = ListedGrantsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `List-grants response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.grants;
}

export async function grantAccess(
  config: AccessToolClientConfig,
  input: GrantAccessRequest,
): Promise<readonly ListedGrant[]> {
  const response = await doRequest(
    config,
    "/grants",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    "Granting access failed",
  );
  const body: unknown = await response.json();
  const parsed = ListedGrantsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Grant-access response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.grants;
}

export async function revokeAccess(
  config: AccessToolClientConfig,
  grantId: string,
): Promise<void> {
  await doRequest(
    config,
    `/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
    "Revoking access failed",
  );
}
