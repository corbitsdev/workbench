// A minimal client for the workflow-run-authenticated authoring surface
// (`@corbits/workflows`'s `./authoring`'s `createWorkflowAuthorRoutes`,
// mounted in `apps/hub` at `/api/workflow-workflow-authoring`). Every
// call carries the run's own sidecar bearer token and run address —
// the same two headers `@corbits/capability-tools` sends — so the hub
// resolves tenant and principal from the run, never from an argument.
import { type } from "arktype";
import {
  runBearerHeaders,
  runBearerFetch,
  type RunBearerClientConfig,
} from "@corbits/workflows/client";

export interface WorkflowAuthoringClientConfig extends RunBearerClientConfig {
  /** The hub's plain HTTP origin, the same value every other tool
   * bundle's `hub*Url` env key carries. */
  readonly hubWorkflowAuthoringUrl: string;
}

export type WorkflowSourceFiles = Readonly<Record<string, string>>;

export type AuthorWorkflowRequest = {
  readonly name: string;
  readonly files: WorkflowSourceFiles;
  readonly message?: string;
};

export type RepublishWorkflowRequest = {
  readonly assetId: string;
  readonly files: WorkflowSourceFiles;
  readonly message?: string;
  readonly expectedHeadSha?: string;
};

export type WorkflowAssetSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly commitSha: string;
};

export type WorkflowSourceSnapshot = {
  readonly assetId: string;
  readonly name: string;
  readonly headSha: string;
  readonly files: WorkflowSourceFiles;
};

export type DeployWorkflowRequest = {
  readonly assetId: string;
  readonly commitSha: string;
  readonly entry: string;
};

export type DeployWorkflowPreviewRequest = {
  readonly assetId: string;
  readonly commitSha: string;
  readonly entry: string;
};

export type WorkflowDeployResult = {
  readonly deploymentId: string;
  readonly definitionAssetId: string;
  readonly status: string;
};

export type ToolPackagePin = {
  readonly name: string;
  readonly version: string;
};

export type WorkflowDeployPreviewResult = {
  readonly commitSha: string;
  readonly entry: string;
  readonly files: readonly string[];
  readonly toolPackagePins: readonly ToolPackagePin[];
  readonly packageName: string;
};

/** The hub refused the request with a canonical error envelope. `code`
 * is the envelope's code (`invalid`, `forbidden`, `not_found`,
 * `conflict`, ...); `currentHeadSha` is set on a republish `conflict` so
 * the caller can re-read and retry. */
export class WorkflowAuthoringRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentHeadSha?: string;
  constructor(
    status: number,
    code: string,
    message: string,
    currentHeadSha?: string,
  ) {
    super(message);
    this.name = "WorkflowAuthoringRequestError";
    this.status = status;
    this.code = code;
    if (currentHeadSha !== undefined) this.currentHeadSha = currentHeadSha;
  }
}

const ErrorResponse = type({
  error: { code: "string", userMessage: "string" },
  "currentHeadSha?": "string",
});

const SummaryResponse = type({
  data: { assetId: "string", name: "string", commitSha: "string" },
});

const SnapshotResponse = type({
  data: {
    assetId: "string",
    name: "string",
    headSha: "string",
    files: "Record<string, string>",
  },
});

const DeployResponse = type({
  data: {
    deploymentId: "string",
    definitionAssetId: "string",
    status: "string",
  },
});

const DeployPreviewResponse = type({
  data: {
    commitSha: "string",
    entry: "string",
    files: "string[]",
    toolPackagePins: type({ name: "string", version: "string" }).array(),
    packageName: "string",
  },
});


function endpoint(config: WorkflowAuthoringClientConfig, path: string): string {
  return `${config.hubWorkflowAuthoringUrl}/api/workflow-workflow-authoring${path}`;
}

async function throwForFailure(
  response: Response,
  operation: string,
): Promise<never> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ErrorResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `${operation} failed: ${response.status} ${response.statusText}`,
    );
  }
  throw new WorkflowAuthoringRequestError(
    response.status,
    parsed.error.code,
    parsed.error.userMessage,
    parsed.currentHeadSha,
  );
}

function parseOrThrow<T>(
  schema: (value: unknown) => T | type.errors,
  body: unknown,
  operation: string,
): T {
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `${operation} response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

export async function authorWorkflow(
  config: WorkflowAuthoringClientConfig,
  input: AuthorWorkflowRequest,
): Promise<WorkflowAssetSummary> {
  const doFetch = runBearerFetch(config);
  const response = await doFetch(endpoint(config, "/author"), {
    method: "POST",
    headers: { ...runBearerHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await throwForFailure(response, "Authoring a workflow");
  return parseOrThrow(
    SummaryResponse,
    await response.json(),
    "Authoring a workflow",
  ).data;
}

export async function republishWorkflow(
  config: WorkflowAuthoringClientConfig,
  input: RepublishWorkflowRequest,
): Promise<WorkflowAssetSummary> {
  const doFetch = runBearerFetch(config);
  const response = await doFetch(endpoint(config, "/republish"), {
    method: "POST",
    headers: { ...runBearerHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    await throwForFailure(response, "Republishing a workflow");
  }
  return parseOrThrow(
    SummaryResponse,
    await response.json(),
    "Republishing a workflow",
  ).data;
}

export async function deployWorkflow(
  config: WorkflowAuthoringClientConfig,
  input: DeployWorkflowRequest,
): Promise<WorkflowDeployResult> {
  const doFetch = runBearerFetch(config);
  const response = await doFetch(
    endpoint(config, `/${encodeURIComponent(input.assetId)}/deploy`),
    {
      method: "POST",
      headers: { ...runBearerHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        commitSha: input.commitSha,
        entry: input.entry,
      }),
    },
  );
  if (!response.ok) await throwForFailure(response, "Deploying a workflow");
  return parseOrThrow(
    DeployResponse,
    await response.json(),
    "Deploying a workflow",
  ).data;
}

export async function previewDeployWorkflow(
  config: WorkflowAuthoringClientConfig,
  input: DeployWorkflowPreviewRequest,
): Promise<WorkflowDeployPreviewResult> {
  const doFetch = runBearerFetch(config);
  const response = await doFetch(
    endpoint(config, `/${encodeURIComponent(input.assetId)}/deploy/preview`),
    {
      method: "POST",
      headers: { ...runBearerHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        commitSha: input.commitSha,
        entry: input.entry,
      }),
    },
  );
  if (!response.ok) {
    await throwForFailure(response, "Previewing a workflow deploy");
  }
  return parseOrThrow(
    DeployPreviewResponse,
    await response.json(),
    "Previewing a workflow deploy",
  ).data;
}

export async function readWorkflowSource(
  config: WorkflowAuthoringClientConfig,
  assetId: string,
): Promise<WorkflowSourceSnapshot> {
  const doFetch = runBearerFetch(config);
  const response = await doFetch(
    endpoint(config, `/${encodeURIComponent(assetId)}/source`),
    { headers: runBearerHeaders(config) },
  );
  if (!response.ok) {
    await throwForFailure(response, "Reading a workflow's source");
  }
  return parseOrThrow(
    SnapshotResponse,
    await response.json(),
    "Reading a workflow's source",
  ).data;
}
