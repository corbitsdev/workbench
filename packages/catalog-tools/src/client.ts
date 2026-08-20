// A minimal client for the workflow-run-authenticated inference-catalog
// surface a running agent calls to ask what this bench can reach for a kind
// of work — the execution half of `@corbits/inference-catalog`'s
// `createWorkflowCatalogRoutes`, mounted in `apps/hub` at
// `/api/workflow-inference-catalog` beside `/api/workflow-connections`.
// Authenticated the same way: sidecar bearer token plus run address, never a
// human browser session.
import { type } from "arktype";
import { Capability } from "@intx/types";

export interface CatalogToolClientConfig {
  /** The hub's plain HTTP origin — the same value connections-tools'
   * `hubConnectionsUrl` and memory-tools' `hubMemoryUrl` reach the hub
   * through. */
  readonly hubCatalogUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const ConceptsResponse = type({
  data: type({
    id: "string",
    title: "string",
    whenToUse: "string",
    availableModels: "number",
    headProvider: "string | null",
  }).array(),
});
export type ConceptSummary = (typeof ConceptsResponse.infer)["data"][number];

const ChainResponse = type({
  concept: "string | null",
  requiredCapabilities: Capability.array(),
  entries: type({
    canonicalName: "string",
    displayName: "string | null",
    providerName: "string",
    plugin: "string",
    offeringId: "string",
    capabilities: Capability.array(),
    price: {
      currency: "string",
      known: "boolean",
      inputUsdPerMTok: "number | null",
      outputUsdPerMTok: "number | null",
    },
    referenceCostUsd: "number | null",
    overCeiling: "boolean",
  }).array(),
  note: "string | null",
});
export type ModelChainResult = typeof ChainResponse.infer;
export type ChainEntry = ModelChainResult["entries"][number];

const EstimateResponse = type({
  concept: "string | null",
  estimates: type({
    canonicalName: "string",
    providerName: "string",
    known: "boolean",
    estimatedUsd: "number | null",
  }).array(),
});
export type EstimateResult = typeof EstimateResponse.infer;

export type ChainRequest = {
  readonly concept?: string | undefined;
  readonly capabilities?: readonly Capability[] | undefined;
  readonly order?: "cheapest" | "catalog" | undefined;
  readonly limit?: number | undefined;
};

export type EstimateRequest = {
  readonly concept?: string | undefined;
  readonly capabilities?: readonly Capability[] | undefined;
  readonly expectedInputTokens: number;
  readonly expectedOutputTokens: number;
};

function authHeaders(config: CatalogToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
    "content-type": "application/json",
  };
}

async function call<T>(
  config: CatalogToolClientConfig,
  path: string,
  what: string,
  schema: (body: unknown) => T | type.errors,
  body?: unknown,
): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubCatalogUrl}/api/workflow-inference-catalog${path}`,
    body === undefined
      ? { headers: authHeaders(config) }
      : {
          method: "POST",
          headers: authHeaders(config),
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => undefined);
    const message =
      typeof detail === "object" &&
      detail !== null &&
      "error" in detail &&
      typeof (detail as { error: { message?: unknown } }).error.message ===
        "string"
        ? (detail as { error: { message: string } }).error.message
        : `${response.status} ${response.statusText}`;
    throw new Error(`${what} failed: ${message}`);
  }
  const parsed = schema(await response.json());
  if (parsed instanceof type.errors) {
    throw new Error(
      `${what} came back in an unexpected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Every kind of work this bench knows, with how many models it currently
 * has for each. Throws on any transport, HTTP, or shape failure — never
 * fabricates a result. */
export async function listConcepts(
  config: CatalogToolClientConfig,
): Promise<readonly ConceptSummary[]> {
  const body = await call(config, "/concepts", "Listing kinds of work", (raw) =>
    ConceptsResponse(raw),
  );
  return body.data;
}

export async function fetchChain(
  config: CatalogToolClientConfig,
  request: ChainRequest,
): Promise<ModelChainResult> {
  return await call(
    config,
    "/chain",
    "Picking models",
    (raw) => ChainResponse(raw),
    request,
  );
}

export async function fetchEstimate(
  config: CatalogToolClientConfig,
  request: EstimateRequest,
): Promise<EstimateResult> {
  return await call(
    config,
    "/estimate",
    "Estimating run cost",
    (raw) => EstimateResponse(raw),
    request,
  );
}
