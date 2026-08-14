// A minimal client for the sanctioned workflow-artifacts HTTP surface
// (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, CL-6000).
// Deliberately duplicated from `@corbits/artifact-tools`' `client.ts`
// rather than imported: this package ships as installable data on the
// native workflow contract (see `./index.ts`'s header comment and
// `test/boundary.test.ts`), so its shipped sources import only `@intx/*`,
// `arktype`, and relative specifiers — never another `@corbits/*`
// package. Authenticates with the sidecar's own bearer token plus the
// run's own mailbox address (both already reach a workflow-process
// child's tool env), never a database handle.
//
// Same client `pain-point-collateral` and `collateral-generation` each
// carry their own copy of, per that convention: a shared `@corbits/*`
// import would violate the boundary test above.
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

const CreatedWorkflowArtifactResponse = type({
  data: { id: "string", version: "number" },
});

/** Persists one artifact. Throws on any transport, HTTP, or shape failure. */
export async function createWorkflowArtifact(
  config: WorkflowArtifactClientConfig,
  input: CreateWorkflowArtifactInput,
): Promise<CreatedWorkflowArtifact> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubArtifactsUrl}/api/workflow-artifacts/`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.sidecarToken}`,
        "x-workflow-run-address": config.runAddress,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
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
