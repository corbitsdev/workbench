// CL-6345: `mcp_call`'s declarative grant-allowance classification. The
// tool itself stays `approval: "ask"` (the static floor cannot vary by
// downstream tool — see `./tool.ts`'s header), so every call still
// parks; the hub's allowance gate then consults this classifier to
// decide whether the parked call rides a standing grant instead of
// waiting for a human. A call rides only when the target server's OWN
// `tools/list` — fetched fresh through the supplied loader, never
// trusted from the model's claim — marks the downstream tool
// `readOnlyHint: true` (the same live verification `mcp_read`'s
// `readOnlyGate` applies), and the covering grant is evaluated against
// the connection-scoped `mcp:<slug>` resource by the gate's own grant
// store. Anything else — a write tool, an unknown tool, an unreachable
// server — classifies as not read-only and stays parked.
import type { McpToolInfo } from "./mcp-client";
import { readOnlyGate } from "./tool";

/** The grant resource one connected MCP server's read allowance is
 * scoped to, mirroring `repo:<owner/name>` / `room:<id>`. */
export function mcpServerResource(slug: string): string {
  return `mcp:${slug}`;
}

/** Loads one tenant-connected server's live tool list, or `null` when
 * the server is not connected or not reachable (which fails the
 * classification closed). */
export type McpServerToolsLoader = (
  tenantId: string,
  serverSlug: string,
) => Promise<readonly McpToolInfo[] | null>;

export type McpCallClassification =
  | { readonly readOnly: true; readonly resource: string }
  | { readonly readOnly: false };

/**
 * The classifier the hub's tool-allowance registry annotates
 * `mcp_call` with. Structurally matches `@corbits/approvals`'
 * `ToolAllowance["classify"]` without this package depending on it.
 */
export function createMcpCallClassifier(
  loadServerTools: McpServerToolsLoader,
): (
  tenantId: string,
  toolArguments: Record<string, unknown>,
) => Promise<McpCallClassification> {
  return async (tenantId, toolArguments) => {
    const server = toolArguments["server"];
    const tool = toolArguments["tool"];
    if (typeof server !== "string" || typeof tool !== "string") {
      return { readOnly: false };
    }
    const tools = await loadServerTools(tenantId, server);
    if (tools === null) return { readOnly: false };
    const gate = readOnlyGate(tools, tool);
    if (!gate.allowed) return { readOnly: false };
    return { readOnly: true, resource: mcpServerResource(server) };
  };
}
