// A minimal client for the workflow-run-authenticated capabilities
// surface a running agent calls to add itself a tool package, skill, or
// model — the execution half of `@corbits/agent-directory`'s already-
// shipped `POST /:definitionId/capabilities` (fail-closed, versioned,
// refresh-on-success) and `GET /capabilities/inventory`.
//
// [Intx gap, CL-6084]: as of this package, those two routes are mounted
// only under the tenant-session-authenticated `TENANT_PREFIX` (see
// `apps/hub/src/index.ts`'s `${TENANT_PREFIX}/agent-definitions` mount),
// authenticated via `createResolveTenant`, which requires a human
// browser session (`vendor/intx/hub-api/src/middleware/tenant.ts`). A
// workflow-process child never holds that session — only its sidecar
// bearer token and its own run address, the same credential
// `@corbits/memory-tools`, `@corbits/skills`' workflow routes, and
// `@corbits/artifacts-hub`'s workflow routes already authenticate with
// via `createWorkflowRunAuthenticator`. Reaching the capabilities route
// with that credential needs a `createWorkflowCapabilityRoutes` factory
// in `@corbits/agent-directory` (mirroring `packages/skills/src/workflow-routes.ts`),
// mounted in `apps/hub` beside `/api/workflow-skills` — neither of which
// is in this package's file set. This client is written against that
// surface's expected shape (mirroring the tenant-session route's own
// request/response contract) so wiring it up is a one-line config change
// once the route exists; until then, every call here fails honestly with
// a network/HTTP error, never a fabricated success.
//
// [Intx gap, CL-6084]: even with that route mounted, a run's own
// `kind: "workflow"` principal is never seeded a `workflow-definition:
// <its own id>/update` grant anywhere in `vendor/intx/hub-api`'s grant
// materialization — so `requireGrant` would still 403 a call the run
// makes for its own definition until that provisioning exists. Neither
// gap is closed here; both are load-bearing for approval and
// grant-checking to happen for real, not just for this client's shape.
import { type } from "arktype";

export interface CapabilityToolClientConfig {
  /** The hub's plain HTTP origin — same value memory-tools' `hubMemoryUrl`
   * and skills' workflow-routes reach the hub through. */
  readonly hubCapabilitiesUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** The calling agent's own definition id. See the [Intx gap] note in
   * `./tool.ts` — no sanctioned way exists yet for a tool execution to
   * learn this on its own; it must be threaded in as part of `env`. */
  readonly definitionId: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type AddCapabilityRequest =
  | { readonly kind: "toolPackage"; readonly name: string }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "model"; readonly canonicalName: string };

export type AddedCapabilities = {
  readonly toolPackagePins: readonly { readonly name: string }[];
  readonly skills: readonly string[];
  readonly model?: string;
};

export type CapabilityInventorySnapshot = {
  readonly toolPackages: readonly string[];
  readonly skills: readonly string[];
  readonly models: readonly string[];
};

/** Mirrors `CapabilityOutOfInventoryError` from
 * `@corbits/agent-directory`'s `capability-inventory.ts` — the fail-
 * closed 400 the route raises when the requested name was never offered
 * in the tenant's live inventory. Distinguished from a bare transport/
 * HTTP error so callers can report honestly what's actually available. */
export class CapabilityOutOfInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityOutOfInventoryError";
  }
}

const AddedCapabilitiesResponse = type({
  toolPackagePins: type({ name: "string" }).array(),
  skills: "string[]",
  "model?": "string",
});

const CapabilityInventoryResponse = type({
  toolPackages: type({ name: "string" }).array(),
  skills: type({ name: "string" }).array(),
  models: type({ canonicalName: "string" }).array(),
});

function authHeaders(
  config: CapabilityToolClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.message` out of a Hono `app.onError` envelope
 * (`{error: {code, message}}`), if `body` matches that shape. */
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

function endpoint(config: CapabilityToolClientConfig, path: string): string {
  return `${config.hubCapabilitiesUrl}/api/workflow-capabilities/${config.definitionId}${path}`;
}

/** Requests one capability addition. Throws
 * `CapabilityOutOfInventoryError` on the route's fail-closed 400, or a
 * bare `Error` on any other transport/HTTP/shape failure — never
 * fabricates a success. */
export async function addCapability(
  config: CapabilityToolClientConfig,
  input: AddCapabilityRequest,
): Promise<AddedCapabilities> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/capabilities"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => undefined);
    const message =
      errorMessageFrom(body) ??
      `"${input.kind === "model" ? input.canonicalName : input.name}" was rejected as out of inventory`;
    throw new CapabilityOutOfInventoryError(message);
  }
  if (!response.ok) {
    throw new Error(
      `Requesting a capability failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = AddedCapabilitiesResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Capability response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Fetches the tenant's live capability inventory — used to report
 * honestly what's actually available when a request is out of
 * inventory. Throws on any transport, HTTP, or shape failure. */
export async function fetchCapabilityInventory(
  config: CapabilityToolClientConfig,
): Promise<CapabilityInventorySnapshot> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubCapabilitiesUrl}/api/workflow-capabilities/inventory`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(
      `Fetching the capability inventory failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = CapabilityInventoryResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Capability inventory response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return {
    toolPackages: parsed.toolPackages.map((entry) => entry.name),
    skills: parsed.skills.map((entry) => entry.name),
    models: parsed.models.map((entry) => entry.canonicalName),
  };
}
