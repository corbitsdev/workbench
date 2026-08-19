// A minimal client for the sanctioned workflow-memory HTTP surface: the
// SAME `/api/tenants/:tenantId/memory/*` mount a browser caller reaches
// (`:tenantId` is never read — see `@corbits/memory`'s
// `registerMemoryRoutes`), authenticated instead with the sidecar's own
// bearer token plus the run's own mailbox address (CL-6296; both already
// reach a workflow-process child's tool env, see
// `apps/sidecar/src/workflow-substrate-factory/step-env.ts`) — never a
// database handle, and never a model-supplied tenant or principal.
// `apps/hub/src/memory-mount.ts`'s `createAccountCallerResolver` resolves
// that pair to the run's ACCOUNT tenant before any route runs, so this
// client never needs to know which tenant it landed in.
import { type } from "arktype";

export interface WorkflowMemoryClientConfig {
  readonly hubMemoryUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

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

// Flat response shapes — `@corbits/memory`'s own routes, never wrapped in
// a `{ data }` envelope the way the deleted `@corbits/memory-hub` package
// used to wrap them. Extra fields the plane returns (`citation`,
// `evidence`, `degraded`, …) are simply not declared here and pass
// through unparsed.
const MemorySearchResponse = type({
  items: type({
    documentId: "string",
    title: "string",
    snippet: "string",
    score: "number",
    kind: "string",
  }).array(),
});

const AddedMemoryEntryResponse = type({
  documentId: "string",
  versionId: "string",
});

const MemoryTimelineResponse = type({
  events: type({
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

// `:tenantId` is a path shape only — `@corbits/memory`'s routes never
// read it; scope always comes from the authenticated caller. The literal
// segment below is never a real tenant id.
function endpoint(config: WorkflowMemoryClientConfig, path: string): string {
  return `${config.hubMemoryUrl}/api/tenants/workflow-run/memory${path}`;
}

async function throwForFailedResponse(
  response: Response,
  action: string,
): Promise<never> {
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
  return parsed.items;
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
  return parsed;
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
  return parsed.events.map(({ at, title, source }) => ({
    at,
    title,
    source,
  }));
}
