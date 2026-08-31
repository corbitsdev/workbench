// Tenant-scoped MCP server connections (CL-6142): drop a server URL in and
// its tools become usable by any agent in the workbench. Same
// fetch+parse+error-envelope convention every other plugins-ui/settings-ui
// API seam uses (see `@corbits/settings-ui`'s `connections-api.ts`), kept
// local to this package rather than importing that package's internal
// `api-request.ts`, which isn't part of its public surface.

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

const ErrorEnvelope = type({
  error: { code: "string", userMessage: "string", refId: "string" },
});

export type McpPreset = {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly url: string;
  readonly connectionMode: "oauth" | "keyless" | "token";
  readonly docsUrl: string;
  readonly icon?: { readonly path: string; readonly hex: string };
  readonly tokenSteps?: readonly string[];
  readonly connected: boolean;
};

const McpPresetSchema = type({
  slug: "string",
  displayName: "string",
  description: "string",
  url: "string",
  connectionMode: "'oauth' | 'keyless' | 'token'",
  docsUrl: "string",
  "icon?": { path: "string", hex: "string" },
  "tokenSteps?": "string[]",
  connected: "boolean",
});

const ListPresetsResult = type({ data: McpPresetSchema.array() });

function mcpServersPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/mcp-servers`;
}

export function mcpOAuthStartPath(tenantId: string, slug: string): string {
  return `/api/tenants/${tenantId}/mcp-servers/oauth/${slug}/start`;
}

async function readError(
  response: Response,
  verb: string,
): Promise<{ readonly message: string; readonly code?: string }> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = ErrorEnvelope(body);
  if (envelope instanceof type.errors) {
    return { message: `The server answered ${response.status} while ${verb}.` };
  }
  return {
    message: envelope.error.userMessage,
    code: envelope.error.code,
  };
}

async function readErrorMessage(
  response: Response,
  verb: string,
): Promise<string> {
  return (await readError(response, verb)).message;
}

export async function listMcpServers(
  tenantId: string,
): Promise<readonly McpServer[]> {
  const response = await fetch(mcpServersPath(tenantId));
  if (!response.ok) {
    throw new McpServersApiError(
      await readErrorMessage(response, "loading MCP servers"),
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ListResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while loading MCP servers: ${parsed.summary}`,
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
  if (!response.ok) {
    throw new McpServersApiError(
      await readErrorMessage(response, "connecting that MCP server"),
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ConnectResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while connecting that MCP server: ${parsed.summary}`,
    );
  }
  return parsed;
}

export async function listMcpPresets(
  tenantId: string,
): Promise<readonly McpPreset[]> {
  const response = await fetch(`${mcpServersPath(tenantId)}/presets`);
  if (!response.ok) {
    throw new McpServersApiError(
      await readErrorMessage(response, "loading MCP presets"),
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ListPresetsResult(body);
  if (parsed instanceof type.errors) {
    throw new McpServersApiError(
      `Unexpected response shape while loading MCP presets: ${parsed.summary}`,
    );
  }
  return parsed.data;
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
  if (!response.ok) {
    const { message, code } = await readError(
      response,
      "connecting that MCP server",
    );
    throw new McpServersApiError(message, response.status, code);
  }
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
  const response = await fetch(`${mcpServersPath(tenantId)}/${slug}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new McpServersApiError(
      await readErrorMessage(response, "disconnecting that MCP server"),
      response.status,
    );
  }
}
