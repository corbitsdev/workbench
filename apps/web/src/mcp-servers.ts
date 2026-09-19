// A workbench's MCP servers, stored as ordinary tenant credentials so the
// platform owns the secret and the deploy owns nothing but a catalog. One
// provider row per server pins the credential handle to that server's origin;
// the credential's `metadata.mcp` carries the catalog a deploy hands the
// sidecar bundle, so redeploying never touches the network.
//
// The catalog lives once on the workspace (top-level) tenant: every
// workbench Myra binds it by walking up, so two workbenches share one Exa
// row and a second workspace sees none of it.
import { MCP_NO_TOKEN_SENTINEL, MCP_STREAMABLE_HTTP_PROVIDER_KEY } from "@corbits/credential-mcp";
import {
  EXA_MCP_SERVER,
  MCP_SERVER_CATALOG,
  mcpCredentialName,
  mcpProviderName,
  type McpServerDeployment,
  type McpTool,
} from "@corbits/myra/workflow-ids";
import { type } from "arktype";

export { MCP_SERVER_CATALOG };
export type { McpCatalogEntry } from "@corbits/myra/workflow-ids";

export class McpServerError extends Error {}

const ProviderShape = type({ id: "string", name: "string", plugin: "string" });
const ProvidersPage = type({ data: ProviderShape.array() });
const CredentialShape = type({
  id: "string",
  name: "string",
  providerId: "string",
  "metadata?": "Record<string, unknown> | null",
});
const CredentialsPage = type({ data: CredentialShape.array() });

const McpToolShape = type({
  name: "string",
  "description?": "string",
  inputSchema: "Record<string, unknown>",
  "annotations?": {
    "readOnlyHint?": "boolean",
    "destructiveHint?": "boolean",
    "idempotentHint?": "boolean",
    "openWorldHint?": "boolean",
  },
});

/** What a stored credential records about its server. Parsed rather than cast:
 * it is read back out of the hub on every deploy. */
const StoredMcpShape = type({
  handle: "string > 0",
  name: "string > 0",
  url: "string > 0",
  auth: "'none' | 'oauth' | 'token'",
  tools: McpToolShape.array(),
});

const DiscoveryShape = type({
  data: {
    serverInfo: "Record<string, unknown>",
    tools: McpToolShape.array(),
  },
});

export type McpAuthKind = typeof StoredMcpShape.infer.auth;

/** One MCP server as the Tools page and the deployer see it. */
export type McpServer = {
  readonly credentialId: string;
  readonly providerId: string;
  readonly handle: string;
  readonly name: string;
  readonly url: string;
  readonly auth: McpAuthKind;
  readonly tools: readonly McpTool[];
};

function tenantPath(tenantId: string, suffix: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}${suffix}`;
}

/** The only tenant-hierarchy read this module needs: a bench is a
 * top-level tenant, so the workspace id is the tenant itself when it has no
 * parent and its parent otherwise. Parsed rather than cast. */
const TenantParentShape = type({ "parentId?": "string | null" });

/** Resolves the workspace (top-level) tenant for any tenant id: a workspace
 * resolves to itself, a workbench to its parent. */
export async function resolveWorkspaceTenantId(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(tenantPath(tenantId, ""), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new McpServerError("resolving this workbench's workspace failed");
  }
  const parsed = TenantParentShape(await response.json());
  if (parsed instanceof type.errors) {
    throw new McpServerError("the workspace response came back an unexpected shape");
  }
  return parsed.parentId ?? tenantId;
}

async function readJson<T>(
  response: Response,
  shape: (value: unknown) => T | type.errors,
  what: string,
): Promise<T> {
  const parsed = shape(await response.json());
  if (parsed instanceof type.errors) {
    throw new McpServerError(`${what} came back an unexpected shape: ${parsed.summary}`);
  }
  return parsed;
}

async function listProviders(
  tenantId: string,
  fetchImpl: typeof fetch,
): Promise<readonly (typeof ProviderShape.infer)[]> {
  const listed = await fetchImpl(tenantPath(tenantId, "/providers"));
  if (!listed.ok) {
    throw new McpServerError("listing the MCP providers failed");
  }
  return (await readJson(listed, ProvidersPage, "the MCP providers")).data;
}

async function listCredentials(
  tenantId: string,
  fetchImpl: typeof fetch,
): Promise<readonly (typeof CredentialShape.infer)[]> {
  const listed = await fetchImpl(tenantPath(tenantId, "/credentials"));
  if (!listed.ok) {
    throw new McpServerError("listing the MCP credentials failed");
  }
  return (await readJson(listed, CredentialsPage, "the MCP credentials")).data;
}

/** The MCP servers stored on a tenant: the credentials sitting on an MCP
 * provider, with the catalog each one recorded when it was added. */
export async function listMcpServers(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly McpServer[]> {
  const [providers, credentials] = await Promise.all([
    listProviders(tenantId, fetchImpl),
    listCredentials(tenantId, fetchImpl),
  ]);
  const mcpProviderIds = new Set(
    providers
      .filter((provider) => provider.plugin === MCP_STREAMABLE_HTTP_PROVIDER_KEY)
      .map((provider) => provider.id),
  );
  const servers: McpServer[] = [];
  for (const credential of credentials) {
    if (!mcpProviderIds.has(credential.providerId)) continue;
    const stored = StoredMcpShape(credential.metadata?.["mcp"]);
    if (stored instanceof type.errors) continue;
    servers.push({
      credentialId: credential.id,
      providerId: credential.providerId,
      handle: stored.handle,
      name: stored.name,
      url: stored.url,
      auth: stored.auth,
      tools: stored.tools,
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/** A provider row per server, pinned to that server's origin so the resolved
 * handle can only ever reach the host it was added for. */
async function ensureMcpProvider(
  tenantId: string,
  handle: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const name = mcpProviderName(handle);
  const existing = (await listProviders(tenantId, fetchImpl)).find(
    (provider) => provider.name === name,
  );
  if (existing !== undefined) return existing.id;
  const created = await fetchImpl(tenantPath(tenantId, "/providers"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
      apiBaseUrl: new URL(url).origin,
    }),
  });
  if (!created.ok) {
    throw new McpServerError(`preparing the ${handle} server's provider failed`);
  }
  return (await readJson(created, ProviderShape, "the MCP server's provider")).id;
}

async function storeCredential(
  args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly handle: string;
    readonly secret: string;
    readonly metadata: unknown;
  },
  fetchImpl: typeof fetch,
): Promise<string> {
  const stored = await fetchImpl(tenantPath(args.tenantId, "/credentials"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: args.providerId,
      name: mcpCredentialName(args.handle),
      type: "api_key",
      secret: args.secret,
      metadata: args.metadata,
    }),
  });
  if (!stored.ok) {
    throw new McpServerError(`storing the ${args.handle} server failed`);
  }
  return (await readJson(stored, CredentialShape, "the MCP server's credential")).id;
}

async function deleteCredential(
  tenantId: string,
  credentialId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  await fetchImpl(tenantPath(tenantId, `/credentials/${encodeURIComponent(credentialId)}`), {
    method: "DELETE",
  });
}

/** Read a server's catalog through the hub, which is the only side that may
 * hold the bearer. `credentialId` names the stored secret to send. */
export async function discoverMcpCatalog(
  args: { readonly tenantId: string; readonly url: string; readonly credentialId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<readonly McpTool[]> {
  const response = await fetchImpl(tenantPath(args.tenantId, "/mcp/discover"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: args.url,
      ...(args.credentialId !== undefined ? { credentialId: args.credentialId } : {}),
    }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = type({ error: "string" })(body);
    throw new McpServerError(
      envelope instanceof type.errors
        ? `this server could not be reached (HTTP ${String(response.status)})`
        : envelope.error,
    );
  }
  return (await readJson(response, DiscoveryShape, "the MCP server's catalog")).data.tools;
}

export type AddMcpServerInput = {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly url: string;
  /** Absent for a keyless server; the stored sentinel then sends no header. */
  readonly token?: string;
};

/**
 * Adds a server to the tenant: provider, credential, then the catalog read
 * with that credential. The credential is stored first because discovery of a
 * token-protected server needs the hub to hold the secret, and is dropped
 * again if the handshake fails, so a failed add leaves nothing behind.
 */
export async function addMcpServer(
  input: AddMcpServerInput,
  fetchImpl: typeof fetch = fetch,
): Promise<McpServer> {
  const providerId = await ensureMcpProvider(input.tenantId, input.handle, input.url, fetchImpl);
  const auth: McpAuthKind = input.token === undefined ? "none" : "token";
  const credentialId = await storeCredential(
    {
      tenantId: input.tenantId,
      providerId,
      handle: input.handle,
      secret: input.token ?? MCP_NO_TOKEN_SENTINEL,
      metadata: {
        mcp: { handle: input.handle, name: input.name, url: input.url, auth, tools: [] },
      },
    },
    fetchImpl,
  );
  let tools: readonly McpTool[];
  try {
    tools = await discoverMcpCatalog(
      { tenantId: input.tenantId, url: input.url, credentialId },
      fetchImpl,
    );
  } catch (cause) {
    await deleteCredential(input.tenantId, credentialId, fetchImpl);
    throw cause;
  }
  const mcp = { handle: input.handle, name: input.name, url: input.url, auth, tools };
  const patched = await fetchImpl(
    tenantPath(input.tenantId, `/credentials/${encodeURIComponent(credentialId)}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { mcp } }),
    },
  );
  if (!patched.ok) {
    await deleteCredential(input.tenantId, credentialId, fetchImpl);
    throw new McpServerError(`recording the ${input.handle} server's tools failed`);
  }
  return { credentialId, providerId, ...mcp };
}

/** Drops a server and the provider row that existed only for it. */
export async function removeMcpServer(
  args: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly providerId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const dropped = await fetchImpl(
    tenantPath(args.tenantId, `/credentials/${encodeURIComponent(args.credentialId)}`),
    { method: "DELETE" },
  );
  if (!dropped.ok) {
    throw new McpServerError("removing this MCP server failed");
  }
  await fetchImpl(tenantPath(args.tenantId, `/providers/${encodeURIComponent(args.providerId)}`), {
    method: "DELETE",
  });
}

/** The workspace's whole MCP catalog: every stored server, with the keyless
 * Exa seeded on first use. Stored once on the workspace (top-level) tenant,
 * then left alone so a later removal is not undone by the next start.
 * Callers pass any tenant id — a workbench id resolves up to its workspace —
 * and each workbench Myra binds the shared rows by walking up, so a chat
 * carries the full catalog. */
export async function ensureWorkspaceMcpServers(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly McpServer[]> {
  const workspaceTenantId = await resolveWorkspaceTenantId(tenantId, fetchImpl);
  const existing = await listMcpServers(workspaceTenantId, fetchImpl);
  if (existing.some((server) => server.handle === EXA_MCP_SERVER.handle)) return existing;
  const added = await addMcpServer(
    {
      tenantId: workspaceTenantId,
      handle: EXA_MCP_SERVER.handle,
      name: EXA_MCP_SERVER.name,
      url: EXA_MCP_SERVER.url,
    },
    fetchImpl,
  );
  return [...existing, added];
}

/** Which of a server's tools may skip the approval ask: only the ones the
 * server itself annotates read-only. Anything unannotated stays ask-gated. */
export function readOnlyToolNames(server: McpServer): readonly string[] {
  return server.tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => `${server.handle}.${tool.name}`);
}

/** A stored server in the shape a deploy hands the definition. */
export function toMcpServerDeployment(server: McpServer): McpServerDeployment {
  const allowWithoutAsk = readOnlyToolNames(server);
  return {
    handle: server.handle,
    url: server.url,
    credentialId: server.credentialId,
    providerName: mcpProviderName(server.handle),
    credentialName: mcpCredentialName(server.handle),
    tools: server.tools,
    ...(allowWithoutAsk.length > 0 ? { allowWithoutAsk } : {}),
  };
}
