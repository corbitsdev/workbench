// A minimal client for the sanctioned workflow-artifacts HTTP surface
// (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, CL-6000):
// one call to persist an artifact, one to list a tenant's most recent.
// Authenticates with the sidecar's own bearer token plus the run's own
// mailbox address (both already reach a workflow-process child's tool
// env, see `apps/sidecar/src/workflow-substrate-factory/step-env.ts`) —
// never a database handle.
import { type } from "arktype";

export interface WorkflowArtifactClientConfig {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type CreateWorkflowArtifactInput = {
  readonly title: string;
  readonly kind: string;
  readonly content: string;
};

export type CreatedWorkflowArtifact = {
  readonly id: string;
  readonly version: number;
};

export type RecentWorkflowArtifact = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly createdAt: string;
};

const CreatedWorkflowArtifactResponse = type({
  data: { id: "string", version: "number" },
});

const RecentWorkflowArtifactsResponse = type({
  data: type({
    id: "string",
    kind: "string",
    title: "string",
    createdAt: "string",
  }).array(),
});

function authHeaders(
  config: WorkflowArtifactClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.runAddress,
  };
}

function endpoint(config: WorkflowArtifactClientConfig, path: string): string {
  return `${config.hubArtifactsUrl}/api/workflow-artifacts${path}`;
}

/** Persists one artifact. Throws on any transport, HTTP, or shape failure. */
export async function createWorkflowArtifact(
  config: WorkflowArtifactClientConfig,
  input: CreateWorkflowArtifactInput,
): Promise<CreatedWorkflowArtifact> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(
      `Workflow artifact create failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = CreatedWorkflowArtifactResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Workflow artifact create response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/**
 * Lists the tenant's most recently updated artifacts. Throws on any
 * transport, HTTP, or shape failure — callers that need graceful
 * degradation catch at their own boundary rather than this client
 * silently swallowing errors.
 */
export async function listRecentWorkflowArtifacts(
  config: WorkflowArtifactClientConfig,
  params: { readonly limit?: number } = {},
): Promise<readonly RecentWorkflowArtifact[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const query =
    params.limit !== undefined ? `?limit=${String(params.limit)}` : "";
  const response = await doFetch(endpoint(config, `/recent${query}`), {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    throw new Error(
      `Workflow artifact list failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = RecentWorkflowArtifactsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Workflow artifact list response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}
