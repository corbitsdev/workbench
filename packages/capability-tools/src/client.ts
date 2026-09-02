// A minimal client for the workflow-run-authenticated capabilities
// surface a running agent calls to add itself a tool package, skill, or
// model — the execution half of `@corbits/agent-directory`'s already-
// shipped `POST /:definitionId/capabilities` (fail-closed, versioned,
// refresh-on-success) and `GET /capabilities/inventory`.
//
// This surface is `@corbits/agent-directory`'s `createWorkflowCapabilityRoutes`
// (`packages/agent-directory/src/workflow-capability-routes.ts`, CL-6086),
// mounted in `apps/hub` at `/api/workflow-capabilities` beside
// `/api/workflow-skills` — authenticated the same way, via
// `createWorkflowRunAuthenticator` (sidecar bearer token + run address),
// never a human browser session.
//
// [Intx gap, tracked durably by CL-6085]: a run's own `kind: "workflow"`
// principal is still never seeded a `workflow-definition: <its own id>/
// update` grant anywhere in `vendor/intx/hub-api`'s grant materialization.
// The workflow-capability route does not block on this: it skips a
// grant-store check for the narrow own-definition case, relying instead
// on `request_capability`'s `approval: "ask"` gate already having put a
// human in front of the call before this client is ever invoked — see
// the route's own file-level comment for the full authorization
// reasoning. `requireGrant` will replace that interim rule once CL-6085
// closes.
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
