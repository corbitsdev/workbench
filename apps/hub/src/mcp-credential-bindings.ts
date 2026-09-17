// The composition root's own port supplying dynamic MCP credential
// bindings. `@corbits/mcp-tools`' credential handles are dynamic (one
// `mcp.<slug>` per tenant-connected server), so this builds one
// `CredentialBinding` per connection `@corbits/connections`' own
// `listMcpServerConnections` lists for the tenant: `handle` mirrors the
// `mcp.<slug>` convention `@corbits/mcp-tools`' `mcpCredentialHandle(slug)`
// resolves against (conforms to `@intx/types`' `ToolCredentialHandle`
// grammar), while `provider` names the stored `mcp:<slug>` provider row
// `listMcpServerConnections` read it from — a separate, unconstrained
// namespace.
//
// `McpCredentialBindingsFor`'s shape is declared locally rather than
// imported: it names nothing chat-specific (`CredentialBinding` is native
// `@intx/types`), so the hub owns its own copy of the port instead of
// depending on `@corbits/chat` for it.
import type { DB } from "@intx/db";
import type { CredentialBinding } from "@intx/types";
import { listMcpServerConnections } from "@corbits/connections";

export type McpCredentialBindingsFor = (
  tenantId: string,
) => Promise<readonly CredentialBinding[]>;

const MCP_TOOLS_PACKAGE = "@corbits/mcp-tools";

export function createMcpCredentialBindingsFor(
  db: DB["db"],
): McpCredentialBindingsFor {
  return async (tenantId: string) => {
    const connections = await listMcpServerConnections(db, tenantId);
    return connections.map((connection): CredentialBinding => ({
      package: MCP_TOOLS_PACKAGE,
      handle: `mcp.${connection.slug}`,
      provider: `mcp:${connection.slug}`,
      locator: "tenant",
    }));
  };
}
