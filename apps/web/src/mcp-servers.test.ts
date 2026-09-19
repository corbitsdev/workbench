// The workspace MCP catalog: the workspace id resolves up from any
// workbench, and the built-in Exa row is stored once on the workspace —
// never on the workbench that triggered the ensure.

import { MCP_STREAMABLE_HTTP_PROVIDER_KEY } from "@corbits/credential-mcp";
import { EXA_MCP_SERVER, mcpCredentialName, mcpProviderName } from "@corbits/myra/workflow-ids";
import { describe, expect, test } from "bun:test";

import {
  ensureWorkspaceMcpServers,
  readOnlyToolNames,
  resolveWorkspaceTenantId,
  toMcpServerDeployment,
  type McpServer,
} from "./mcp-servers";

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

function workspaceCatalogFetch(opts: {
  readonly exaPresent: boolean;
  readonly linearPresent?: boolean;
}): {
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
          data: [
            ...(opts.exaPresent
              ? [
                  {
                    id: "p-exa",
                    name: mcpProviderName(EXA_MCP_SERVER.handle),
                    plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
                  },
                ]
              : []),
            ...(opts.linearPresent === true
              ? [
                  {
                    id: "p-linear",
                    name: mcpProviderName("linear"),
                    plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
                  },
                ]
              : []),
          ],
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
          data: [
            ...(opts.exaPresent
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
              : []),
            ...(opts.linearPresent === true
              ? [
                  {
                    id: "c-linear",
                    name: mcpCredentialName("linear"),
                    providerId: "p-linear",
                    metadata: {
                      mcp: {
                        handle: "linear",
                        name: "Linear",
                        url: "https://mcp.linear.app/mcp",
                        auth: "oauth",
                        tools: [
                          {
                            name: "list_issues",
                            inputSchema: {},
                            annotations: { readOnlyHint: true },
                          },
                          { name: "create_issue", inputSchema: {} },
                        ],
                      },
                    },
                  },
                ]
              : []),
          ],
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

describe("ensureWorkspaceMcpServers", () => {
  test("from a workbench id, an existing workspace Exa is shared with no writes", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: true });
    const servers = await ensureWorkspaceMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    // Nothing is ever stored on the workbench itself.
    expect(calls.some((call) => call.path.startsWith(`/api/tenants/${WORKBENCH_ID}/`))).toBe(false);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  test("a missing Exa is created on the workspace, not the workbench", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: false });
    const servers = await ensureWorkspaceMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.path.startsWith(`/api/tenants/${WORKSPACE_ID}/`)).toBe(true);
    }
  });

  test("a chat's deploy binds every workspace server, not just Exa, with no writes", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: true, linearPresent: true });
    const servers = await ensureWorkspaceMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle).sort()).toEqual(["exa", "linear"]);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });
});

const LINEAR_SERVER: McpServer = {
  credentialId: "c-linear",
  providerId: "p-linear",
  handle: "linear",
  name: "Linear",
  url: "https://mcp.linear.app/mcp",
  auth: "oauth",
  tools: [
    { name: "list_issues", inputSchema: {}, annotations: { readOnlyHint: true } },
    { name: "create_issue", inputSchema: {} },
  ],
};

describe("toMcpServerDeployment", () => {
  test("only the server-annotated read-only tools skip the ask; the rest stay gated", () => {
    expect(readOnlyToolNames(LINEAR_SERVER)).toEqual(["linear.list_issues"]);
    expect(toMcpServerDeployment(LINEAR_SERVER).allowWithoutAsk).toEqual(["linear.list_issues"]);
  });

  test("a server with no read-only tools carries no bypass at all", () => {
    const deployment = toMcpServerDeployment({
      ...LINEAR_SERVER,
      tools: [{ name: "create_issue", inputSchema: {} }],
    });
    expect(deployment.allowWithoutAsk).toBeUndefined();
  });
});
