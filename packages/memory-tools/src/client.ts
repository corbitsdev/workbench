// A minimal client for the sanctioned workflow-memory HTTP surface
// (`@corbits/memory-hub`'s `createWorkflowMemoryRoutes`): search, add,
// and list against the mounted `@corbits/memory` plane. Authenticates
// with the sidecar's own bearer token plus the run's own mailbox
// address (both already reach a workflow-process child's tool env, see
// `apps/sidecar/src/workflow-substrate-factory/step-env.ts`) — never a
// database handle, and never a model-supplied tenant or principal.
import { type } from "arktype";

export interface WorkflowMemoryClientConfig {
  readonly hubMemoryUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Thrown specifically for the hub's `createUnavailableWorkflowMemoryRoutes`
 * response (503, `error.code === "unavailable"`) — the honest "memory
 * plane isn't mounted" signal, distinct from a real transport/HTTP
 * failure. Callers (`./tool.ts`) use this to degrade calmly instead of
 * surfacing a tool error.
 */
export class MemoryUnavailableError extends Error {}

export type SearchMemoryInput = {
  readonly query: string;
  readonly limit?: number;
  readonly kinds?: readonly string[];
};

export type MemorySearchItem = {
  readonly documentId: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly kind: string;
};

export type AddMemoryInput = {
  readonly title: string;
  readonly text: string;
  readonly kind?: string;
};

export type AddedMemoryEntry = {
  readonly documentId: string;
  readonly versionId: string;
};

export type MemoryTimelineEntry = {
  readonly at: string;
  readonly title: string;
  readonly source: string;
};

const MemorySearchResponse = type({
  data: {
    items: type({
      documentId: "string",
      title: "string",
      snippet: "string",
      score: "number",
      kind: "string",
    }).array(),
  },
});

const AddedMemoryEntryResponse = type({
  data: { documentId: "string", versionId: "string" },
});

const MemoryTimelineResponse = type({
  data: type({
    at: "string",
    title: "string",
    source: "string",
  }).array(),
});

function authHeaders(
  config: WorkflowMemoryClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.runAddress,
  };
}

function endpoint(config: WorkflowMemoryClientConfig, path: string): string {
  return `${config.hubMemoryUrl}/api/workflow-memory${path}`;
}

async function throwForFailedResponse(
  response: Response,
  action: string,
): Promise<never> {
  if (response.status === 503) {
    const body: unknown = await response.json().catch(() => null);
    const code = (body as { error?: { code?: string } } | null)?.error?.code;
    if (code === "unavailable") {
      throw new MemoryUnavailableError(
        "Memory plane is not configured on this hub",
      );
    }
  }
  throw new Error(
    `${action} failed: ${response.status} ${response.statusText}`,
  );
}

/** Searches the tenant's memory. Throws on any transport, HTTP, or shape failure. */
export async function searchMemory(
  config: WorkflowMemoryClientConfig,
  input: SearchMemoryInput,
): Promise<readonly MemorySearchItem[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/search"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    await throwForFailedResponse(response, "Memory search");
  }
  const body: unknown = await response.json();
  const parsed = MemorySearchResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Memory search response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data.items;
}

/** Adds one memory entry. Throws on any transport, HTTP, or shape failure. */
export async function addMemory(
  config: WorkflowMemoryClientConfig,
  input: AddMemoryInput,
): Promise<AddedMemoryEntry> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/add"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    await throwForFailedResponse(response, "Memory add");
  }
  const body: unknown = await response.json();
  const parsed = AddedMemoryEntryResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Memory add response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Lists the tenant's recent memory timeline. Throws on any transport, HTTP, or shape failure. */
export async function listMemory(
  config: WorkflowMemoryClientConfig,
  params: { readonly limit?: number } = {},
): Promise<readonly MemoryTimelineEntry[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const query =
    params.limit !== undefined ? `?limit=${String(params.limit)}` : "";
  const response = await doFetch(endpoint(config, `/list${query}`), {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    await throwForFailedResponse(response, "Memory list");
  }
  const body: unknown = await response.json();
  const parsed = MemoryTimelineResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Memory list response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}
