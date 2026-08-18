// The plugins directory's seam onto `@workbench/connections`' tenant-scoped
// MCP server routes (CL-6142/CL-6152/CL-6261): drop a full endpoint URL in
// and, once the server-side probe (`mcp-probe.ts`, via
// `mcp-server-routes.ts`) proves it's a real MCP server, it becomes a
// first-class connection — same shape whether it came from a hand-typed
// URL, a curated preset (`mcp-presets.ts`), or an OAuth+DCR round trip
// (`mcp-oauth-routes.ts`). `@corbits/plugins-ui` has its own copy of this
// client (`mcp-servers-api.ts`) against the exact same routes — chat-ui
// cannot import that package (settings-ui/plugins-ui depend on chat-ui,
// not the other way around), so this is its own small client, matching
// `./plugins-api.ts`'s own header comment on why that duplication exists.

import { type } from "arktype";

export class McpServersApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type McpServer = {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
};

export type McpServerConnected = McpServer & {
  readonly toolCount: number;
};

export type McpPresetRow = {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly url: string;
  readonly keyOptional: boolean;
  readonly docsUrl: string;
  readonly connected: boolean;
};

const McpServerSchema = type({
  slug: "string",
  name: "string",
  url: "string",
});

const ListResult = type({ data: McpServerSchema.array() });

const ConnectResult = type({
  slug: "string",
  name: "string",
  url: "string",
  toolCount: "number",
});

const McpPresetSchema = type({
  slug: "string",
  displayName: "string",
  description: "string",
  url: "string",
  keyOptional: "boolean",
  docsUrl: "string",
  connected: "boolean",
});

const ListPresetsResult = type({ data: McpPresetSchema.array() });

const ErrorEnvelope = type({
  error: { message: "string", "code?": "string" },
});

function mcpServersPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/mcp-servers`;
}

/** A path-safe stand-in for a not-yet-connected ad hoc server's slug — the
 * OAuth start route only uses this to name its state cookie and, when the
 * authorization server never provides a nicer name, is re-derived from the
 * real display name at connect time anyway (`mcp-oauth-routes.ts`'s own
 * callback), so it never has to be the server's final slug. */
function slugForOAuthStart(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "server";
}

/** The OAuth+DCR connect flow's entry point — a curated preset's fixed
 * slug, or an ad hoc `name`+`url` for a custom server the "Add MCP server"
 * dialog already probed as `requiresOAuth`. Navigating the browser here
 * (never a fetch) is deliberate: this redirects off-site to the server's
 * own authorization page. */
export function mcpOAuthStartPath(
  tenantId: string,
  slug: string,
  adHoc?: { readonly name: string; readonly url: string },
): string {
  const base = `${mcpServersPath(tenantId)}/oauth/${encodeURIComponent(slug)}/start`;
  if (adHoc === undefined) return base;
  const query = new URLSearchParams({ url: adHoc.url, name: adHoc.name });
  return `${base}?${query.toString()}`;
}

export function mcpOAuthStartPathForServer(
  tenantId: string,
  name: string,
  url: string,
): string {
  return mcpOAuthStartPath(tenantId, slugForOAuthStart(name), { name, url });
}

async function readError(
  response: Response,
  verb: string,
): Promise<{ readonly message: string; readonly code?: string }> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = ErrorEnvelope(body);
  if (envelope instanceof type.errors) {
    return {
      message: `The server answered ${response.status} while ${verb}.`,
    };
  }
  return envelope.error.code === undefined
    ? { message: envelope.error.message }
    : { message: envelope.error.message, code: envelope.error.code };
}

async function throwFor(response: Response, verb: string): Promise<never> {
  const { message, code } = await readError(response, verb);
  throw new McpServersApiError(message, response.status, code);
}

export async function listMcpServers(
  tenantId: string,
): Promise<readonly McpServer[]> {
  const response = await fetch(mcpServersPath(tenantId));
  if (!response.ok) await throwFor(response, "loading MCP servers");
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ListResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while loading MCP servers: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

export async function listMcpPresets(
  tenantId: string,
): Promise<readonly McpPresetRow[]> {
  const response = await fetch(`${mcpServersPath(tenantId)}/presets`);
  if (!response.ok) await throwFor(response, "loading MCP server presets");
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ListPresetsResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while loading MCP server presets: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

export async function connectMcpServer(
  tenantId: string,
  input: {
    readonly name: string;
    readonly url: string;
    readonly token: string | undefined;
  },
): Promise<McpServerConnected> {
  const response = await fetch(mcpServersPath(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) await throwFor(response, "connecting that MCP server");
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ConnectResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while connecting that MCP server: ${parsed.summary}`,
    );
  }
  return parsed;
}

export async function connectMcpPreset(
  tenantId: string,
  presetSlug: string,
  token: string | undefined,
): Promise<McpServerConnected> {
  const response = await fetch(mcpServersPath(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ presetSlug, token }),
  });
  if (!response.ok) await throwFor(response, "connecting that MCP server");
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ConnectResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while connecting that MCP server: ${parsed.summary}`,
    );
  }
  return parsed;
}

export async function disconnectMcpServer(
  tenantId: string,
  slug: string,
): Promise<void> {
  const response = await fetch(
    `${mcpServersPath(tenantId)}/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    await throwFor(response, "disconnecting that MCP server");
  }
}
