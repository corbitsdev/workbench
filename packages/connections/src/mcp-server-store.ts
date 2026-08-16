// The direct-DB read backing `mcp_list_servers`
// (`@corbits/mcp-tools`' `registry-client.ts`, via
// `./workflow-connection-routes.ts`'s `GET /mcp-servers`): every `mcp:<slug>`
// provider row this tenant owns with an active credential, name, and URL.
//
// A workflow-run-authenticated route has no tenant-session cookies, so it
// cannot reuse `./mcp-server-routes.ts`'s hub-HTTP-API listing the way the
// tenant-session Plugins surface does — it queries the same `provider`/
// `credential` tables directly, the same way `@intx/db`'s own
// `listVisibleProviders`/`resolveProviderByName` do, scoped to this tenant
// alone (no ancestor-chain inheritance: an MCP server is tenant-minted data,
// never a catalog default a child tenant would inherit).
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";

const MCP_PROVIDER_PREFIX = "mcp:";

export type McpServerConnection = {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
};

export async function listMcpServerConnections(
  db: DB["db"],
  tenantId: string,
): Promise<readonly McpServerConnection[]> {
  const providers = await db.query.provider.findMany({
    where: and(eq(schema.provider.tenantId, tenantId)),
  });
  const mcpProviders = providers.filter((row) =>
    row.name.startsWith(MCP_PROVIDER_PREFIX),
  );
  if (mcpProviders.length === 0) return [];

  const credentials = await db.query.credential.findMany({
    where: eq(schema.credential.tenantId, tenantId),
  });
  const credentialByProviderId = new Map(
    credentials
      .filter((row) => row.status === "active")
      .map((row) => [row.providerId, row]),
  );

  const connections: McpServerConnection[] = [];
  for (const provider of mcpProviders) {
    const credential = credentialByProviderId.get(provider.id);
    if (credential === undefined) continue;
    connections.push({
      slug: provider.name.slice(MCP_PROVIDER_PREFIX.length),
      name: credential.name,
      url: provider.apiBaseUrl ?? "",
    });
  }
  return connections;
}
