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

function tenantDetailResponse(id: string, parentId: string | null): Response {
  return Response.json({ id, parentId });
}

describe("resolveWorkspaceTenantId", () => {
  test("a top-level tenant resolves to itself", async () => {
    const fetchImpl = (async () =>
      tenantDetailResponse(WORKSPACE_ID, null)) as unknown as typeof fetch;
    await expect(resolveWorkspaceTenantId(WORKSPACE_ID, fetchImpl)).resolves.toBe(WORKSPACE_ID);
  });

  test("a workbench resolves up to its parent workspace", async () => {
    const fetchImpl = (async () =>
      tenantDetailResponse(WORKBENCH_ID, WORKSPACE_ID)) as unknown as typeof fetch;
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

type StoredRow = {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly metadata: { readonly mcp: { readonly handle: string; readonly name: string; readonly url: string; readonly auth: string; readonly tools: readonly never[] } };
};

function exaRow(credentialId: string, providerId: string): StoredRow {
  return {
    id: credentialId,
    name: mcpCredentialName(EXA_MCP_SERVER.handle),
    providerId,
    metadata: {
      mcp: {
        handle: EXA_MCP_SERVER.handle,
        name: EXA_MCP_SERVER.name,
        url: EXA_MCP_SERVER.url,
        auth: "none",
        tools: [],
      },
    },
  };
}

function tokenRow(): StoredRow {
  return {
    id: "c-linear",
    name: mcpCredentialName("linear"),
    providerId: "p-linear-wb",
    metadata: {
      mcp: {
        handle: "linear",
        name: "Linear",
        url: "https://mcp.linear.app/mcp",
        auth: "token",
        tools: [],
      },
    },
  };
}

function workspaceCatalogFetch(opts: {
  readonly exaPresent: boolean;
  /** Legacy workbench-scoped rows, from before the catalog moved up. */
  readonly workbenchRows?: readonly StoredRow[];
}): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const workspaceProviders =
    opts.exaPresent === true
      ? [
          {
            id: "p-exa",
            name: mcpProviderName(EXA_MCP_SERVER.handle),
            plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
          },
        ]
      : [];
  const workspaceCredentials = opts.exaPresent === true ? [exaRow("c-exa", "p-exa")] : [];
  // Mutable: DELETEs drop rows, so tests can assert what moved and what stayed.
  let workbenchCredentials = [...(opts.workbenchRows ?? [])];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });

    if (path === `/api/tenants/${WORKBENCH_ID}`) return tenantDetailResponse(WORKBENCH_ID, WORKSPACE_ID);
    if (path === `/api/tenants/${WORKSPACE_ID}`) return tenantDetailResponse(WORKSPACE_ID, null);
    if (path === `/api/tenants/${WORKBENCH_ID}/providers` && method === "GET") {
      return Response.json({
        data: workbenchCredentials.map((row) => ({
          id: row.providerId,
          name: mcpProviderName(row.metadata.mcp.handle),
          plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
        })),
      });
    }
    if (path === `/api/tenants/${WORKBENCH_ID}/credentials` && method === "GET") {
      return Response.json({ data: workbenchCredentials });
    }
    if (
      method === "DELETE" &&
      (path.startsWith(`/api/tenants/${WORKBENCH_ID}/credentials/`) ||
        path.startsWith(`/api/tenants/${WORKBENCH_ID}/providers/`))
    ) {
      const credentialId = path.split("/").pop() ?? "";
      workbenchCredentials = workbenchCredentials.filter(
        (row) => row.id !== credentialId && row.providerId !== credentialId,
      );
      return Response.json({ ok: true });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/providers`) {
      if (method === "GET") {
        return Response.json({ data: workspaceProviders });
      }
      const id = `p-added-${String(workspaceProviders.length)}`;
      workspaceProviders.push({
        id,
        name: mcpProviderName(EXA_MCP_SERVER.handle),
        plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
      });
      return Response.json({
        id,
        name: mcpProviderName(EXA_MCP_SERVER.handle),
        plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
      });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/credentials`) {
      if (method === "GET") {
        return Response.json({ data: workspaceCredentials });
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      let body: { metadata?: StoredRow["metadata"]; name?: string; providerId?: string } = {};
      try {
        body = JSON.parse(bodyText) as typeof body;
      } catch {
        body = {};
      }
      const row: StoredRow = {
        id: `c-added-${String(workspaceCredentials.length)}`,
        name: body.name ?? mcpCredentialName(EXA_MCP_SERVER.handle),
        providerId: body.providerId ?? "p-exa",
        metadata: body.metadata ?? exaRow("c-added-0", "p-exa").metadata,
      };
      workspaceCredentials.push(row);
      return Response.json({ id: row.id, name: row.name, providerId: row.providerId });
    }
    if (path === `/api/tenants/${WORKSPACE_ID}/mcp/discover`) {
      return Response.json({ data: { serverInfo: {}, tools: [] } });
    }
    if (path.startsWith(`/api/tenants/${WORKSPACE_ID}/credentials/`)) {
      const credentialId = path.split("/").pop() ?? "";
      const row = workspaceCredentials.find((candidate) => candidate.id === credentialId);
      if (method === "PATCH" && row !== undefined) {
        const patchText = typeof init?.body === "string" ? init.body : "{}";
        try {
          const parsed = JSON.parse(patchText) as { metadata?: StoredRow["metadata"] };
          if (parsed.metadata !== undefined) {
            workspaceCredentials.splice(workspaceCredentials.indexOf(row), 1, { ...row, metadata: parsed.metadata });
          }
        } catch {
          // Keep the placeholder row; discovery recorded nothing new.
        }
      }
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
    // The migration check reads the workbench, but nothing is ever stored there.
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([]);
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

  test("a legacy workbench Exa moves up to an empty workspace exactly once", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({
      exaPresent: false,
      workbenchRows: [exaRow("c-exa-wb", "p-exa-wb")],
    });
    const servers = await ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    // One re-add on the workspace (POST credentials), then the workbench row
    // goes away — and no second add follows, because the moved row lists back.
    const workspaceAdds = calls.filter(
      (call) => call.method === "POST" && call.path === `/api/tenants/${WORKSPACE_ID}/credentials`,
    );
    expect(workspaceAdds).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === `/api/tenants/${WORKBENCH_ID}/credentials/c-exa-wb`,
      ),
    ).toBe(true);
  });

  test("a legacy workbench Exa dedupes against a workspace Exa instead of moving", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({
      exaPresent: true,
      workbenchRows: [exaRow("c-exa-wb", "p-exa-wb")],
    });
    const servers = await ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    // No re-add: the workspace already carries Exa, so the workbench twin is
    // just dropped.
    expect(
      calls.some((call) => call.method === "POST" && call.path.endsWith("/credentials")),
    ).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === `/api/tenants/${WORKBENCH_ID}/credentials/c-exa-wb`,
      ),
    ).toBe(true);
  });

  test("a legacy token row stays orphaned on the workbench — its secret cannot move", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({
      exaPresent: true,
      workbenchRows: [tokenRow()],
    });
    await ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl);
    expect(
      calls.some(
        (call) => call.method === "DELETE" && call.path.includes("/credentials/c-linear"),
      ),
    ).toBe(false);
  });

  test("a failed migration still leaves the workspace catalog ensured", async () => {
    const { fetchImpl } = workspaceCatalogFetch({ exaPresent: false });
    const failing: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === `/api/tenants/${WORKBENCH_ID}/providers`) {
        return new Response("gone", { status: 500 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const servers = await ensureBuiltInMcpServers(WORKBENCH_ID, failing);
    expect(servers.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
  });

  test("concurrent ensures share one flight instead of adding Exa twice", async () => {
    const { fetchImpl, calls } = workspaceCatalogFetch({ exaPresent: false });
    const [first, second] = await Promise.all([
      ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl),
      ensureBuiltInMcpServers(WORKBENCH_ID, fetchImpl),
    ]);
    expect(first.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    expect(second.map((server) => server.handle)).toContain(EXA_MCP_SERVER.handle);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path === `/api/tenants/${WORKSPACE_ID}/credentials`,
      ),
    ).toHaveLength(1);
  });
});
