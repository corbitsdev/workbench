// The workspace MCP catalog: the workspace id resolves up from any
// workbench, and the built-in Exa row is stored once on the workspace —
// never on the workbench that triggered the ensure.

import { MCP_STREAMABLE_HTTP_PROVIDER_KEY } from "@corbits/credential-mcp";
import { EXA_MCP_SERVER, mcpCredentialName, mcpProviderName } from "@corbits/myra/workflow-ids";
import { describe, expect, test } from "bun:test";

import { ensureBuiltInMcpServers, resolveWorkspaceTenantId } from "./mcp-servers";

const WORKSPACE_ID = "ws-1";
const WORKBENCH_ID = "wb-1";

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

type Call = { readonly method: string; readonly path: string };

function tenantDetailResponse(parentId: string | null): Response {
  return Response.json({ id: WORKBENCH_ID, parentId });
}

describe("resolveWorkspaceTenantId", () => {
  test("a top-level tenant resolves to itself", async () => {
    const fetchImpl = (async () => tenantDetailResponse(null)) as unknown as typeof fetch;
    await expect(resolveWorkspaceTenantId(WORKSPACE_ID, fetchImpl)).resolves.toBe(WORKSPACE_ID);
  });

  test("a workbench resolves up to its parent workspace", async () => {
    const fetchImpl = (async () => tenantDetailResponse(WORKSPACE_ID)) as unknown as typeof fetch;
    await expect(resolveWorkspaceTenantId(WORKBENCH_ID, fetchImpl)).resolves.toBe(WORKSPACE_ID);
  });

  test("a tenant detail without a parentId resolves to itself", async () => {
    const fetchImpl = (async () => Response.json({ id: WORKSPACE_ID })) as unknown as typeof fetch;
    await expect(resolveWorkspaceTenantId(WORKSPACE_ID, fetchImpl)).resolves.toBe(WORKSPACE_ID);
  });

  test("a failed tenant read throws instead of guessing", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(resolveWorkspaceTenantId(WORKBENCH_ID, fetchImpl)).rejects.toThrow();
  });
});

function workspaceCatalogFetch(opts: { readonly exaPresent: boolean }): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });

    if (path === `/api/tenants/${WORKBENCH_ID}`) return tenantDetailResponse(WORKSPACE_ID);
    if (path === `/api/tenants/${WORKSPACE_ID}`) return tenantDetailResponse(null);
    if (path === `/api/tenants/${WORKSPACE_ID}/providers`) {
      if (method === "GET") {
        return Response.json({
          data: opts.exaPresent
            ? [
                {
                  id: "p-exa",
                  name: mcpProviderName(EXA_MCP_SERVER.handle),
                  plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
                },
              ]
            : [],
        });
      }
      return Response.json({
        id: "p-exa",
        name: mcpProviderName(EXA_MCP_SERVER.handle),
        plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
      });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/credentials`) {
      if (method === "GET") {
        return Response.json({
          data: opts.exaPresent
            ? [
                {
                  id: "c-exa",
                  name: mcpCredentialName(EXA_MCP_SERVER.handle),
                  providerId: "p-exa",
                  metadata: {
                    mcp: {
                      handle: EXA_MCP_SERVER.handle,
                      name: EXA_MCP_SERVER.name,
                      url: EXA_MCP_SERVER.url,
                      auth: "none",
                      tools: [],
                    },
                  },
                },
              ]
            : [],
        });
      }
      return Response.json({ id: "c-exa", name: "x", providerId: "p-exa" });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/mcp/discover`) {
      return Response.json({ data: { serverInfo: {}, tools: [] } });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/credentials/c-exa`) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("ensureBuiltInMcpServers", () => {
  test("from a workbench id, an existing workspace Exa is shared with no writes", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: true });
    const servers = await ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    // Nothing is ever stored on the workbench itself.
    expect(calls.some((call) => call.path.startsWith(`/api/tenants/${WORKBENCH_ID}/`))).toBe(false);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  test("a missing Exa is created on the workspace, not the workbench", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: false });
    const servers = await ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.path.startsWith(`/api/tenants/${WORKSPACE_ID}/`)).toBe(true);
    }
  });
});
