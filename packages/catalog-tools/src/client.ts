// A minimal client for the workflow-run-authenticated inference-catalog
// surface a running agent calls to ask what this bench can reach for a kind
// of work — the execution half of `@corbits/inference-catalog`'s
// `createWorkflowCatalogRoutes`, mounted in `apps/hub` at
// `/api/workflow-inference-catalog` beside `/api/workflow-connections`.
// Authenticated the same way: sidecar bearer token plus run address, never a
// human browser session.
import { type } from "arktype";
import {
  Capability,
  CreateModelOffering,
  ModelOfferingResponse,
  ModelProviderResponse,
  ModelResponse,
  UpdateModelOffering,
  paginatedSchema,
} from "@intx/types";

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
      errorMessageFrom(detail) ?? `${response.status} ${response.statusText}`;
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

// --- Tenant catalog administration -----------------------------------
//
// `list_model_concepts`/`pick_models`/`estimate_run_cost` above read the
// run-authenticated `/api/workflow-inference-catalog` surface. The tools
// below instead write through the tenant-admin surface Interchange's own
// `apps/hub-web` settings UI uses directly:
// `vendor/intx/hub-api/src/routes/{models,model-providers,model-offerings}.ts`,
// mounted at `/api/tenants/:id/catalog/{models,providers,offerings}`. They
// carry the same sidecar bearer token and run address as every other call
// in this file — the hub is expected to resolve that credential to this
// tenant's own principal for these routes exactly as it already does for
// `/api/workflow-inference-catalog`.

export interface CatalogAdminClientConfig {
  /** Same hub origin as {@link CatalogToolClientConfig.hubCatalogUrl}. */
  readonly hubCatalogUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** The tenant this run belongs to — the tenant-admin routes are scoped
   * by this id in their URL path. */
  readonly tenantId: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Thrown when no model this tenant owns directly matches the requested
 * canonical name. */
export class UnknownCanonicalNameError extends Error {}

/** Thrown when no model-provider this tenant owns directly matches the
 * requested name. */
export class UnknownProviderNameError extends Error {}

const ModelsPage = paginatedSchema(ModelResponse);
const ModelProvidersPage = paginatedSchema(ModelProviderResponse);

function adminAuthHeaders(
  config: CatalogAdminClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
    "content-type": "application/json",
  };
}

async function adminCall<T>(
  config: CatalogAdminClientConfig,
  path: string,
  what: string,
  schema: (body: unknown) => T | type.errors,
  init?: RequestInit,
): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubCatalogUrl}/api/tenants/${config.tenantId}${path}`,
    { ...init, headers: { ...adminAuthHeaders(config), ...init?.headers } },
  );
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => undefined);
    const message =
      errorMessageFrom(detail) ?? `${response.status} ${response.statusText}`;
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

/** Finds the id of a model this tenant owns directly by its canonical
 * name, paging through the tenant's own model list. Throws
 * {@link UnknownCanonicalNameError} rather than inventing an id when
 * nothing matches. */
export async function findModelIdByCanonicalName(
  config: CatalogAdminClientConfig,
  canonicalName: string,
): Promise<string> {
  let cursor: string | undefined;
  do {
    const qs = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = await adminCall(
      config,
      `/catalog/models${qs}`,
      "Listing this workbench's own models",
      (raw) => ModelsPage(raw),
    );
    const found = page.data.find((row) => row.canonicalName === canonicalName);
    if (found !== undefined) return found.id;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  throw new UnknownCanonicalNameError(
    `No model named "${canonicalName}" in this workbench's own catalog.`,
  );
}

/** Finds the id of a model-provider this tenant owns directly by its
 * name, paging through the tenant's own provider list. Throws
 * {@link UnknownProviderNameError} rather than inventing an id when
 * nothing matches. */
export async function findModelProviderIdByName(
  config: CatalogAdminClientConfig,
  providerName: string,
): Promise<string> {
  let cursor: string | undefined;
  do {
    const qs = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = await adminCall(
      config,
      `/catalog/providers${qs}`,
      "Listing this workbench's own model providers",
      (raw) => ModelProvidersPage(raw),
    );
    const found = page.data.find((row) => row.name === providerName);
    if (found !== undefined) return found.id;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  throw new UnknownProviderNameError(
    `No model provider named "${providerName}" in this workbench's own catalog.`,
  );
}

export type CreateOfferingRequest = {
  readonly modelId: string;
  readonly providerId: string;
  readonly priority?: number;
  readonly capabilities?: readonly Capability[];
};

/** Creates a tenant-owned offering pairing a tenant-owned model with a
 * tenant-owned provider. */
export async function createOffering(
  config: CatalogAdminClientConfig,
  request: CreateOfferingRequest,
): Promise<typeof ModelOfferingResponse.infer> {
  return await adminCall(
    config,
    "/catalog/offerings",
    "Creating the offering",
    (raw) => ModelOfferingResponse(raw),
    { method: "POST", body: JSON.stringify(CreateModelOffering.assert(request)) },
  );
}

/** Reorders an offering this tenant already owns directly. */
export async function setOfferingPriority(
  config: CatalogAdminClientConfig,
  offeringId: string,
  priority: number,
): Promise<typeof ModelOfferingResponse.infer> {
  return await adminCall(
    config,
    `/catalog/offerings/${offeringId}`,
    "Setting the offering's priority",
    (raw) => ModelOfferingResponse(raw),
    {
      method: "PATCH",
      body: JSON.stringify(UpdateModelOffering.assert({ priority })),
    },
  );
}

/** Restricts an offering this tenant already owns directly, taking it out
 * of resolution without deleting its pricing history. */
export async function disableOffering(
  config: CatalogAdminClientConfig,
  offeringId: string,
): Promise<typeof ModelOfferingResponse.infer> {
  return await adminCall(
    config,
    `/catalog/offerings/${offeringId}`,
    "Disabling the offering",
    (raw) => ModelOfferingResponse(raw),
    {
      method: "PATCH",
      body: JSON.stringify(UpdateModelOffering.assert({ disabled: true })),
    },
  );
}
