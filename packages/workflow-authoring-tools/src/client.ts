// Two surfaces, one credential.
//
// `deployWorkflow` speaks the STOCK `@intx/hub-api` routes: `GET
// /api/tenants/:tenantId/models` for the tenant's resolved inference
// catalog, then `POST /api/tenants/:tenantId/workflows/deployments`. The
// run bearer authenticates both — `apps/hub/src/workflow-run-tenant-auth.ts`
// resolves the sidecar token + run address into a principal and tenant
// across the whole tenant subtree. The tenant id is a path segment on
// every stock route, so it rides in the client config; it is never
// trusted as authority, since the hub sets the acting tenant from the
// authenticated run alone.
//
// `authorWorkflow` / `republishWorkflow` / `readWorkflowSource` /
// `previewDeployWorkflow` still call the Workbench-specific
// `/api/workflow-workflow-authoring` mount. Their stock equivalent is git
// smart-HTTP on the asset repo, which no run-bearer credential can reach
// today: `createGitTokenAuth` accepts only an `itx_pat_`/`itx_svc_` git
// token, and the stock mint route refuses a caller with no browser
// session. See CL-8171 for the upstream ask that would let these four
// follow `deploy` onto stock routes.
import { type } from "arktype";
import {
  runBearerHeaders,
  runBearerFetch,
  type RunBearerClientConfig,
} from "./run-bearer";

export interface WorkflowAuthoringClientConfig extends RunBearerClientConfig {
  /** The hub's plain HTTP origin, the same value every other tool
   * bundle's `hub*Url` env key carries. */
  readonly hubWorkflowAuthoringUrl: string;
  /** The run's own tenant — the `:tenantId` segment of every stock route. */
  readonly tenantId: string;
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

/** The stock deploy route's response: the anchor run projected as a
 * deployment record. */
const StockDeployResponse = type({
  id: "string",
  definitionAssetId: "string",
  status: "string",
});

/** The stock model-discovery response, narrowed to the two fields the
 * deploy's ordered offering chain is built from. */
const DiscoveredModels = type({
  offerings: type({ offeringId: "string", priority: "number" }).array(),
}).array();

/** The stock error envelope (`{error: {code, message}}`), which the
 * vendored routes use in place of the canonical `userMessage` shape. */
const StockErrorResponse = type({
  error: { code: "string", message: "string" },
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

function stockEndpoint(
  config: WorkflowAuthoringClientConfig,
  path: string,
): string {
  return `${config.hubWorkflowAuthoringUrl}/api/tenants/${encodeURIComponent(config.tenantId)}${path}`;
}

async function throwForStockFailure(
  response: Response,
  operation: string,
): Promise<never> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = StockErrorResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `${operation} failed: ${response.status} ${response.statusText}`,
    );
  }
  throw new WorkflowAuthoringRequestError(
    response.status,
    parsed.error.code,
    parsed.error.message,
  );
}

/**
 * The ordered catalog offering chain a deploy hands the hub, rebuilt on
 * the client from the tenant's resolved model catalog.
 *
 * The deleted `/api/workflow-workflow-authoring/:assetId/deploy` mirror
 * resolved this server-side with `listVisibleOfferings` sorted by
 * `priority`; the stock route takes it from the caller instead. The
 * discovery route already applies the same inheritance, shadowing and
 * disable cascade, and groups its offerings under each model, so the
 * flattened list is re-sorted by priority here to restore the single
 * global ordering the mirror produced. `offeringId` is deduplicated
 * because the stock route rejects a chain with a repeat.
 */
export function orderedSourceOfferingIds(
  models: readonly { readonly offerings: readonly OfferingOrdering[] }[],
): readonly string[] {
  const flattened = models.flatMap((m) => [...m.offerings]);
  flattened.sort(
    (a, b) =>
      a.priority - b.priority || a.offeringId.localeCompare(b.offeringId),
  );
  return [...new Set(flattened.map((o) => o.offeringId))];
}

export type OfferingOrdering = {
  readonly offeringId: string;
  readonly priority: number;
};

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
    headers: {
      ...runBearerHeaders(config),
      "content-type": "application/json",
    },
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
    headers: {
      ...runBearerHeaders(config),
      "content-type": "application/json",
    },
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

  const catalogResponse = await doFetch(stockEndpoint(config, "/models"), {
    headers: runBearerHeaders(config),
  });
  if (!catalogResponse.ok) {
    await throwForStockFailure(
      catalogResponse,
      "Reading the workbench's inference catalog",
    );
  }
  const models = parseOrThrow(
    DiscoveredModels,
    await catalogResponse.json(),
    "Reading the workbench's inference catalog",
  );
  const sourceOfferingIds = orderedSourceOfferingIds(models);
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new WorkflowAuthoringRequestError(
      409,
      "invalid",
      "No catalog offerings are visible to this workbench, so a workflow cannot be deployed",
    );
  }

  const response = await doFetch(
    stockEndpoint(config, "/workflows/deployments"),
    {
      method: "POST",
      headers: {
        ...runBearerHeaders(config),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: {
          kind: "asset",
          assetId: input.assetId,
          package: { format: "source", commitSha: input.commitSha },
        },
        entry: input.entry,
        sourceOfferingIds,
        defaultSourceOfferingId,
      }),
    },
  );
  if (!response.ok) {
    await throwForStockFailure(response, "Deploying a workflow");
  }
  const deployment = parseOrThrow(
    StockDeployResponse,
    await response.json(),
    "Deploying a workflow",
  );
  return {
    deploymentId: deployment.id,
    definitionAssetId: deployment.definitionAssetId,
    status: deployment.status,
  };
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
      headers: {
        ...runBearerHeaders(config),
        "content-type": "application/json",
      },
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
