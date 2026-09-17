// What this bundle reads, and from where.
//
// Both reads are STOCK Interchange tenant routes, addressed with the
// workflow run's own bearer credential (sidecar token plus run address),
// which the hub resolves to this run's principal and tenant:
//
//   GET /api/tenants/:tenantId/models  — the bench's resolved model
//       catalog. The ancestor walk, shadowing, disable suppression and
//       each offering's active price per currency are all the platform's
//       own work; this package restates none of it.
//   GET /api/tenants/:tenantId         — the bench itself, for the model
//       policy in its `config` blob under `corbits.modelPolicy`.
//
// There is no `/api/workflow-inference-catalog` mirror any more, and no
// hub-side chain resolution: the chain is computed here, in the workflow
// child, from those two reads.
import { type } from "arktype";
import { DiscoveredModel } from "@corbits/inference-catalog/catalog";
import {
  readModelPolicy,
  type BenchModelPolicy,
} from "@corbits/inference-catalog/policy";

export interface CatalogToolClientConfig {
  /** The hub's plain HTTP origin — the same value connections-tools'
   * `hubConnectionsUrl` and memory-tools' `hubMemoryUrl` reach the hub
   * through. */
  readonly hubCatalogUrl: string;
  /** The run's own tenant — the `:tenantId` segment of a stock route. */
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const DiscoveredModels = DiscoveredModel.array();

const TenantResponse = type({
  id: "string",
  "config?": type({ "[string]": "unknown" }).or("null"),
});

function authHeaders(config: CatalogToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.userMessage` or `error.message` out of the hub's error
 * envelope, if `body` matches that shape. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const fields = error as { userMessage?: unknown; message?: unknown };
  if (typeof fields.userMessage === "string") return fields.userMessage;
  return typeof fields.message === "string" ? fields.message : undefined;
}

async function read<T>(
  config: CatalogToolClientConfig,
  path: string,
  what: string,
  schema: (body: unknown) => T | type.errors,
): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubCatalogUrl}/api/tenants/${encodeURIComponent(config.tenantId)}${path}`,
    { headers: authHeaders(config) },
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

/** This bench's resolved model catalog. Throws on any transport, HTTP, or
 * shape failure — never fabricates a catalog. */
export async function fetchCatalog(
  config: CatalogToolClientConfig,
): Promise<readonly DiscoveredModel[]> {
  return await read(config, "/models", "Reading this bench's models", (raw) =>
    DiscoveredModels(raw),
  );
}

/** This bench's model policy, out of its own tenant config blob. */
export async function fetchModelPolicy(
  config: CatalogToolClientConfig,
): Promise<BenchModelPolicy> {
  const tenant = await read(
    config,
    "",
    "Reading this bench's settings",
    (raw) => TenantResponse(raw),
  );
  return readModelPolicy(tenant.config ?? {});
}
