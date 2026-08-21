// A minimal client for the two workflow-run-authenticated surfaces this
// bundle's execution reaches:
//
//   - `@corbits/agent-workflow-authoring`'s `createWorkflowAuthorRoutes`
//     (`POST/POST .../author`, `.../republish`) — mounted at
//     `/api/workflow-workflow-authoring`, sidecar-bearer authenticated,
//     tenant/principal scoped from the authenticated run alone.
//   - `@intx/hub-api`'s EXISTING `POST /api/tenants/:tenantId/workflows/deployments`
//     route (`vendor/intx/hub-api/src/routes/workflows.ts`) — the
//     source-based deploy surface that installs, probes, gates, and
//     freezes a code-sourced workflow definition. This client calls it
//     exactly as documented; it does not reimplement any of that gating.
//
// Same auth-header/error-handling/arktype-parsing shape as
// `@corbits/skills-tools`' and `@corbits/agent-directory-tools`' clients:
// a sidecar bearer token plus the run's own address, never a
// model-supplied identity.
import { type } from "arktype";

export interface WorkflowAuthoringToolClientConfig {
  /** Reaches `@corbits/agent-workflow-authoring`'s workflow-run routes. */
  readonly hubWorkflowAuthoringUrl: string;
  /** Reaches `@intx/hub-api`'s tenant-scoped workflow deploy route. */
  readonly hubWorkflowsUrl: string;
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type AuthoredWorkflowAsset = {
  readonly assetId: string;
  readonly name: string;
  readonly commitSha: string;
};

export type DeployedWorkflow = {
  readonly id: string;
  readonly tenantId: string;
  readonly definitionAssetId: string;
  readonly status: string;
  readonly createdAt: string;
};

const AuthoredWorkflowAssetResponse = type({
  data: {
    assetId: "string",
    name: "string",
    commitSha: "string",
  },
});

const DeployedWorkflowResponse = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});

function authHeaders(
  config: WorkflowAuthoringToolClientConfig,
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

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Thrown when the author/republish route rejects the request — a bad
 * name, a rejected codebase (missing `interchange.workflow` entry, a
 * committed `node_modules`, etc.), a forbidden grant, or an unknown
 * asset — as distinct from a bare transport/HTTP failure. */
export class WorkflowAuthoringError extends Error {}

function authoringEndpoint(
  config: WorkflowAuthoringToolClientConfig,
  path: string,
): string {
  return `${config.hubWorkflowAuthoringUrl}/api/workflow-workflow-authoring${path}`;
}

export async function authorWorkflow(
  config: WorkflowAuthoringToolClientConfig,
  input: {
    readonly name: string;
    readonly files: Record<string, string>;
    readonly message?: string;
  },
): Promise<AuthoredWorkflowAsset> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(authoringEndpoint(config, "/author"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (
    response.status === 400 ||
    response.status === 403 ||
    response.status === 409
  ) {
    throw new WorkflowAuthoringError(
      await readErrorMessage(
        response,
        `Authoring the workflow failed: ${response.status}`,
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Authoring the workflow failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = AuthoredWorkflowAssetResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Author-workflow response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

export async function republishWorkflow(
  config: WorkflowAuthoringToolClientConfig,
  input: {
    readonly assetId: string;
    readonly files: Record<string, string>;
    readonly message?: string;
  },
): Promise<AuthoredWorkflowAsset> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(authoringEndpoint(config, "/republish"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (
    response.status === 400 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 409
  ) {
    throw new WorkflowAuthoringError(
      await readErrorMessage(
        response,
        `Updating the workflow failed: ${response.status}`,
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Updating the workflow failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = AuthoredWorkflowAssetResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Republish-workflow response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Thrown when the deploy route rejects the request — an invalid or
 * unsupported source, a definition that failed install/probe/gate, or a
 * missing asset — as distinct from a bare transport/HTTP failure. */
export class DeployWorkflowError extends Error {}

export async function deployAuthoredWorkflow(
  config: WorkflowAuthoringToolClientConfig,
  input: {
    readonly assetId: string;
    readonly entry: string;
    readonly sources: readonly Record<string, unknown>[];
    readonly defaultSource: string;
    readonly pin?: string;
  },
): Promise<DeployedWorkflow> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubWorkflowsUrl}/api/tenants/${config.tenantId}/workflows/deployments`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        source: { kind: "asset", assetId: input.assetId },
        entry: input.entry,
        sources: input.sources,
        defaultSource: input.defaultSource,
        ...(input.pin !== undefined ? { pin: input.pin } : {}),
      }),
    },
  );
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 409
  ) {
    throw new DeployWorkflowError(
      await readErrorMessage(
        response,
        `Deploying the workflow failed: ${response.status}`,
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Deploying the workflow failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = DeployedWorkflowResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Deploy-workflow response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
