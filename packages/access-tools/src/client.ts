// A minimal client for the STOCK `@intx/hub-api` principal and grant
// routes (`/api/tenants/:tenantId/principals`, `/grants`), spoken with the
// workflow run's own bearer credential: the sidecar token plus the run
// address, which the hub resolves to this run's principal and tenant before
// the stock handler's own `requireGrant` check runs. There is no
// Workbench-specific mirror of these routes any more.
//
// The tenant id is a path segment on every stock tenant route, so it rides
// in the client config; the sidecar threads it onto the step env from the
// hub's signed deploy frame. It is never trusted as authority — the hub sets
// the acting tenant from the authenticated run alone.
//
// Grants are NOT inherited across the tenant ancestor tree, so every read
// and write here is the run's own tenant and nothing above it.
import { type } from "arktype";
import { evaluateGrants, type GrantRule } from "@intx/authz";

export interface AccessToolClientConfig {
  /** The hub's plain HTTP origin. */
  readonly hubAccessUrl: string;
  /** The run's own tenant — the `:tenantId` segment of every stock route. */
  readonly tenantId: string;
  /** The run's own principal, whose authority bounds every grant it makes. */
  readonly principalId: string;
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

function tenantBase(config: AccessToolClientConfig): string {
  return `${config.hubAccessUrl}/api/tenants/${encodeURIComponent(config.tenantId)}`;
}

/** Pulls a message out of either error envelope the hub emits: the
 * canonical `{error: {code, userMessage, refId}}` and the stock
 * `{error: {code, message}}` shape the vendored routes use. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  for (const key of ["userMessage", "message"] as const) {
    if (key in error) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Thrown when the hub rejects the request as forbidden — the caller's own
 * principal holds no `principal:*`/`grant:*` grant — distinct from a bare
 * transport/HTTP failure, so a caller can report honestly that a human must
 * grant it access first. */
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
  const response = await doFetch(`${tenantBase(config)}${path}`, {
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

const PAGE_LIMIT = 100;

const PrincipalsPage = type({
  data: type({
    id: "string",
    kind: "'user'|'agent'|'workflow'",
    refId: "string",
    status: "'active'|'suspended'|'invited'|'deactivated'",
  }).array(),
  "nextCursor?": "string | null",
});

const GrantsPage = type({
  data: type({
    id: "string",
    principalId: "string | null",
    resource: "string",
    action: "string",
    effect: "'allow'|'deny'|'ask'",
    origin: "'system'|'role'|'creator'|'invoker'",
    "roleId?": "string | null",
    "conditions?": "Record<string, unknown> | null",
    "expiresAt?": "string | null",
  }).array(),
  "nextCursor?": "string | null",
});

const CreatedGrant = type({
  id: "string",
  principalId: "string | null",
  resource: "string",
  action: "string",
  effect: "'allow'|'deny'|'ask'",
});

type GrantRow = (typeof GrantsPage.infer)["data"][number];

/** Walks every page of a stock paginated collection. The tool surfaces a
 * tenant's whole principal or grant list, so a truncated first page would
 * read as "that principal has no grants" — a wrong answer, not a slow one. */
async function readAllPages<T>(
  config: AccessToolClientConfig,
  path: string,
  query: URLSearchParams,
  failureLabel: string,
  parse: (
    body: unknown,
  ) =>
    | { data: readonly T[]; nextCursor?: string | null | undefined }
    | type.errors,
): Promise<readonly T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams(query);
    params.set("limit", String(PAGE_LIMIT));
    if (cursor !== undefined) params.set("cursor", cursor);
    const response = await doRequest(
      config,
      `${path}?${params.toString()}`,
      {},
      failureLabel,
    );
    const parsed = parse(await response.json());
    if (parsed instanceof type.errors) {
      throw new Error(
        `${failureLabel}: response did not match the expected shape: ${parsed.summary}`,
      );
    }
    items.push(...parsed.data);
    const next = parsed.nextCursor;
    if (next === undefined || next === null) return items;
    cursor = next;
  }
}

export async function listPrincipals(
  config: AccessToolClientConfig,
): Promise<readonly ListedPrincipal[]> {
  return await readAllPages(
    config,
    "/principals",
    new URLSearchParams(),
    "Listing principals failed",
    (body) => PrincipalsPage(body),
  );
}

export interface ListGrantsFilter {
  readonly principalId?: string;
  readonly resource?: string;
}

async function listGrantRows(
  config: AccessToolClientConfig,
  filter?: ListGrantsFilter,
): Promise<readonly GrantRow[]> {
  const params = new URLSearchParams();
  if (filter?.principalId !== undefined) {
    params.set("principalId", filter.principalId);
  }
  if (filter?.resource !== undefined) params.set("resource", filter.resource);
  return await readAllPages(
    config,
    "/grants",
    params,
    "Listing grants failed",
    (body) => GrantsPage(body),
  );
}

export async function listGrants(
  config: AccessToolClientConfig,
  filter?: ListGrantsFilter,
): Promise<readonly ListedGrant[]> {
  const rows = await listGrantRows(config, filter);
  return rows.map((row) => ({
    id: row.id,
    principalId: row.principalId,
    resource: row.resource,
    action: row.action,
    effect: row.effect,
  }));
}

function toGrantRule(row: GrantRow): GrantRule {
  return {
    id: row.id,
    resource: row.resource,
    action: row.action,
    effect: row.effect,
    origin: row.origin,
    conditions: row.conditions ?? null,
    expiresAt:
      row.expiresAt === undefined || row.expiresAt === null
        ? null
        : new Date(row.expiresAt),
    roleId: row.roleId ?? null,
    principalId: row.principalId,
  };
}

/** Thrown when the caller asks to grant or revoke authority it does not
 * itself hold. */
export class DelegationCeilingError extends Error {}

/**
 * The delegation ceiling: a caller may only grant (or revoke) authority it
 * already holds itself, or `grant:*`/`create` alone would let any principal
 * escalate past its own reach.
 *
 * Stock `POST /grants` has no such check, so the tool enforces it before
 * calling: it reads the caller's own grants in its own tenant and evaluates
 * each requested pair with `@intx/authz`'s own `evaluateGrants`, the same
 * engine the hub authorizes with. A parent tenant's grant is never consulted
 * — grants are not inherited across the ancestor tree, unlike credentials
 * and tool packages.
 *
 * Returns the first action outside the ceiling, or null when every pair is
 * within it.
 *
 * Two fidelity gaps against a server-side check, both recorded as upstream
 * asks on CL-7575: role-derived grants are not visible through the stock
 * principal-filtered listing, and the read-then-write is not atomic.
 */
export async function firstActionOutsideCeiling(
  config: AccessToolClientConfig,
  resource: string,
  actions: readonly string[],
): Promise<string | null> {
  const own = await listGrantRows(config, {
    principalId: config.principalId,
  });
  const rules = own.map(toGrantRule);
  for (const action of actions) {
    const result = await evaluateGrants(rules, resource, action, {
      principalId: config.principalId,
      tenantId: config.tenantId,
    });
    if (result.effect !== "allow") return action;
  }
  return null;
}

export async function grantAccess(
  config: AccessToolClientConfig,
  input: GrantAccessRequest,
): Promise<readonly ListedGrant[]> {
  const outside = await firstActionOutsideCeiling(
    config,
    input.resource,
    input.actions,
  );
  if (outside !== null) {
    throw new DelegationCeilingError(
      `Cannot grant "${input.resource}" "${outside}": exceeds the caller's own authority`,
    );
  }

  // Stock `POST /grants` creates one resource/action pair per call, so a
  // multi-action request is one call per action. A failure part-way leaves
  // the already-created grants in place and surfaces loudly rather than
  // rolling back behind the caller's back.
  const created: ListedGrant[] = [];
  for (const action of input.actions) {
    const response = await doRequest(
      config,
      "/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalId: input.principalId,
          resource: input.resource,
          action,
          effect: "allow",
          // The invoking human's authority delegated this grant: the tool
          // declares `approval: "ask"`, so a human approved this exact
          // principal/resource/actions triple before this call ran.
          origin: "invoker",
        }),
      },
      "Granting access failed",
    );
    const parsed = CreatedGrant(await response.json());
    if (parsed instanceof type.errors) {
      throw new Error(
        `Grant-access response did not match the expected shape: ${parsed.summary}`,
      );
    }
    created.push({
      id: parsed.id,
      principalId: parsed.principalId,
      resource: parsed.resource,
      action: parsed.action,
      effect: parsed.effect,
    });
  }
  return created;
}

export async function revokeAccess(
  config: AccessToolClientConfig,
  grantId: string,
): Promise<void> {
  const response = await doRequest(
    config,
    `/grants/${encodeURIComponent(grantId)}`,
    {},
    "Revoking access failed",
  );
  const target = CreatedGrant(await response.json());
  if (target instanceof type.errors) {
    throw new Error(
      `Grant lookup response did not match the expected shape: ${target.summary}`,
    );
  }
  const outside = await firstActionOutsideCeiling(config, target.resource, [
    target.action,
  ]);
  if (outside !== null) {
    throw new DelegationCeilingError(
      `Cannot revoke "${target.resource}" "${target.action}": exceeds the caller's own authority`,
    );
  }
  await doRequest(
    config,
    `/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
    "Revoking access failed",
  );
}
