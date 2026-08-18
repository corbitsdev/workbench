// The direct-DB read backing `mcp_list_servers`
// (`@corbits/mcp-tools`' `registry-client.ts`, via
// `./workflow-connection-routes.ts`'s `GET /mcp-servers`): every `mcp:<slug>`
// provider row visible to this tenant, with an active credential, name, and
// URL.
//
// A workflow-run-authenticated route has no tenant-session cookies, so it
// cannot reuse `./mcp-server-routes.ts`'s hub-HTTP-API listing the way the
// tenant-session Plugins surface does — it queries the same `provider`/
// `credential` tables directly, walking the tenant ancestor chain exactly
// the way `@intx/db`'s own `resolveProviderByName`/`listAssetsForTenant`
// (and the hub-api `GET /providers` route) already do: a child tenant sees
// every MCP server an ancestor connected, and a same-slug connection made at
// the child shadows the ancestor's (CL-6191, matching the inheritance fix
// already shipped for `@corbits/skills`' asset listing). Mutating a
// connection — connect, disconnect — stays own-tenant only; see
// `./mcp-server-routes.ts`.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { getAncestorChain, schema } from "@intx/db";

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
  const chain = await getAncestorChain(db, tenantId);
  const bySlug = new Map<string, McpServerConnection>();

  for (const tid of chain) {
    const providers = await db.query.provider.findMany({
      where: and(eq(schema.provider.tenantId, tid)),
    });
    const mcpProviders = providers.filter((row) =>
      row.name.startsWith(MCP_PROVIDER_PREFIX),
    );
    if (mcpProviders.length === 0) continue;

    const credentials = await db.query.credential.findMany({
      where: eq(schema.credential.tenantId, tid),
    });
    const credentialByProviderId = new Map(
      credentials
        .filter((row) => row.status === "active")
        .map((row) => [row.providerId, row]),
    );

    for (const provider of mcpProviders) {
      const slug = provider.name.slice(MCP_PROVIDER_PREFIX.length);
      // Leaf-to-root order means the closer tenant's connection for this
      // slug was already recorded — an ancestor's same-slug row never
      // overwrites it.
      if (bySlug.has(slug)) continue;
      const credential = credentialByProviderId.get(provider.id);
      if (credential === undefined) continue;
      bySlug.set(slug, {
        slug,
        name: credential.name,
        // Both connect paths store the server's FULL MCP endpoint here —
        // never a bare origin, which drops paths like `/mcp` and dies at
        // the CDN.
        url: provider.apiBaseUrl ?? "",
      });
    }
  }

  return [...bySlug.values()];
}
