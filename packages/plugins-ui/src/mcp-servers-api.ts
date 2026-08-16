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
  error: { message: "string", "code?": "string" },
});

function mcpServersPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/mcp-servers`;
}

async function readErrorMessage(
  response: Response,
  verb: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = ErrorEnvelope(body);
  return envelope instanceof type.errors
    ? `The server answered ${response.status} while ${verb}.`
    : envelope.error.message;
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
