// The `McpCredentialBindingsFor` port every `FoldedRunsDeps` below is wired
// with — see `@corbits/folded-runs`' `types.ts` for why this has to be
// supplied by the composition root rather than derived by the deploy-time
// capability walk. `@corbits/mcp-tools`' credential handles are dynamic
// (one `mcp.<slug>` per tenant-connected server), so this builds one
// `CredentialBinding` per connection `@corbits/connections`' own
// `listMcpServerConnections` lists for the tenant: `handle` mirrors the
// `mcp.<slug>` convention `@corbits/mcp-tools`' `mcpCredentialHandle(slug)`
// resolves against (conforms to `@intx/types`' `ToolCredentialHandle`
// grammar), while `provider` names the stored `mcp:<slug>` provider row
// `listMcpServerConnections` read it from — a separate, unconstrained
// namespace.
import type { DB } from "@intx/db";
import type { CredentialBinding } from "@intx/types";
import type { McpCredentialBindingsFor } from "@corbits/folded-runs";
import { listMcpServerConnections } from "@corbits/connections";

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
