// A minimal client for the sanctioned workflow-artifacts HTTP surface
// (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, CL-6000).
// Duplicated rather than imported, matching
// `workflows/last-30-days-research/src/artifact-client.ts`'s convention:
// this is Scout's own tool body, not a shared package, so it stays inside
// this package rather than adding a new cross-cutting dependency.
// Authenticates with the sidecar's own bearer token plus the run's own
// mailbox address (both already reach a workflow-process child's tool
// env), never a database handle.
import { type } from "arktype";

export interface ScoutArtifactClientConfig {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type CreateScoutArtifactInput = {
  readonly title: string;
  readonly kind: string;
  readonly content: string;
};

export type CreatedScoutArtifact = {
  readonly id: string;
  readonly version: number;
};

export type ScoutArtifactListItem = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly createdAt: string;
};

const CreatedScoutArtifactResponse = type({
  data: { id: "string", version: "number" },
});

const ScoutArtifactListResponse = type({
  data: type({
    id: "string",
    title: "string",
    kind: "string",
    createdAt: "string",
  }).array(),
});

function authHeaders(
  config: ScoutArtifactClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.runAddress,
  };
}

/** Persists one artifact. Throws on any transport, HTTP, or shape failure. */
export async function createScoutArtifact(
  config: ScoutArtifactClientConfig,
  input: CreateScoutArtifactInput,
): Promise<CreatedScoutArtifact> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubArtifactsUrl}/api/workflow-artifacts/`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Scout artifact create failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = CreatedScoutArtifactResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Scout artifact create response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Lists the tenant's most recent artifacts. Throws on any transport, HTTP, or shape failure. */
export async function listRecentScoutArtifacts(
  config: ScoutArtifactClientConfig,
  params: { readonly limit?: number } = {},
): Promise<readonly ScoutArtifactListItem[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const query =
    params.limit !== undefined ? `?limit=${String(params.limit)}` : "";
  const response = await doFetch(
    `${config.hubArtifactsUrl}/api/workflow-artifacts/recent${query}`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(
      `Scout artifact list failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = ScoutArtifactListResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Scout artifact list response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}
