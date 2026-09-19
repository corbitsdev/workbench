// Deploys list MCP servers from the top of the tenant ancestry, not from the
// child tenant the agent lives under. The stub below stands in for the tenant
// reads so the walk, the top-level shortcut and the failure modes are pinned.

import { describe, expect, test } from "bun:test";

import { McpServerError, resolveWorkspaceTenantId } from "./mcp-servers";

function tenantFetch(
  tenants: Record<string, { id: string; parentId: string | null }>,
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    const id = decodeURIComponent(url.slice("/api/tenants/".length));
    const tenant = tenants[id];
    if (tenant === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(tenant), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

describe("resolveWorkspaceTenantId", () => {
  test("a child tenant resolves to its top-level ancestor", async () => {
    const fetchImpl = tenantFetch({
      tnt_agent: { id: "tnt_agent", parentId: "tnt_team" },
      tnt_team: { id: "tnt_team", parentId: "tnt_primary" },
      tnt_primary: { id: "tnt_primary", parentId: null },
    });
    await expect(resolveWorkspaceTenantId("tnt_agent", fetchImpl)).resolves.toBe("tnt_primary");
  });

  test("a top-level tenant resolves to itself without another read", async () => {
    let reads = 0;
    const fetchImpl = tenantFetch({ tnt_primary: { id: "tnt_primary", parentId: null } });
    const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
      reads += 1;
      return fetchImpl(input, init);
    }) as typeof fetch;
    await expect(resolveWorkspaceTenantId("tnt_primary", counting)).resolves.toBe("tnt_primary");
    expect(reads).toBe(1);
  });

  test("an unknown tenant fails instead of listing the wrong catalog", async () => {
    const fetchImpl = tenantFetch({});
    await expect(resolveWorkspaceTenantId("tnt_missing", fetchImpl)).rejects.toBeInstanceOf(
      McpServerError,
    );
  });
});
