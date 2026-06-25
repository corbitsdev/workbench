import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

let forbidden = false;
let context: { tenantId: string } | null = { tenantId: "tenant-1" };
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: async () => ({ context, forbidden }),
}));

const listAvailableToolSummaries = mock(
  async (_db: unknown, _tenantId: string) => [
    {
      name: "attio_query_records",
      providerName: "attio",
      description: "Find records.",
    },
    {
      name: "list_artifacts",
      providerName: "workbench",
      description: "List artifacts.",
    },
  ],
);
const getAvailableToolDetail = mock(
  async (_db: unknown, _tenantId: string, name: string) => {
    if (name === "attio_query_records") {
      return {
        name,
        providerName: "attio",
        description: "Find records.",
        inputSchema: { properties: {} },
      };
    }
    if (name === "list_artifacts") {
      return {
        name,
        providerName: "workbench",
        description: "List artifacts.",
        inputSchema: { properties: {} },
      };
    }
    return null;
  },
);
// Keyed by TOOL NAME. A hub-backed tool (no registry tarball) is absent from
// the map, so the route degrades it to version: null.
const resolveToolVersions = mock(
  async (
    _db: unknown,
    _tenantId: string,
    _toolNames: string[],
    _assetService: unknown,
  ) => new Map([["attio_query_records", "0.1.7"]]),
);

mock.module("../lib/tenant-tools", () => ({
  listAvailableToolSummaries,
  getAvailableToolDetail,
  resolveToolVersions,
}));

const { createToolsRouter } = await import("./tools");

const db = {} as unknown as Parameters<typeof createToolsRouter>[0];
const assetService = {} as unknown as Parameters<typeof createToolsRouter>[1];

async function call(path: string) {
  const app = new Hono<{ Variables: { userId: string; userName: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", createToolsRouter(db, assetService));
  return app.request(path);
}

describe("createToolsRouter", () => {
  it("lists tenant-available tools", async () => {
    context = { tenantId: "tenant-1" };
    forbidden = false;
    const res = await call("/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools[0]?.name).toBe("attio_query_records");
  });

  it("returns a tool detail with input schema", async () => {
    const res = await call("/tools/attio_query_records");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tool: { name: string; inputSchema: unknown };
    };
    expect(body.tool.name).toBe("attio_query_records");
    expect("inputSchema" in body.tool).toBe(true);
  });

  it("404s when the tenant cannot run the tool", async () => {
    const res = await call("/tools/linear_list_issues");
    expect(res.status).toBe(404);
  });

  it("403s when the requested tenant is not accessible", async () => {
    forbidden = true;
    const res = await call("/tools");
    expect(res.status).toBe(403);
    forbidden = false;
  });

  it("includes resolved registry version on the list endpoint", async () => {
    context = { tenantId: "tenant-1" };
    forbidden = false;
    const res = await call("/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { name: string; version: string | null }[];
    };
    const attio = body.tools.find((t) => t.name === "attio_query_records");
    expect(attio?.version).toBe("0.1.7");
  });

  it("returns version: null when no registry version resolves", async () => {
    context = { tenantId: "tenant-1" };
    forbidden = false;
    resolveToolVersions.mockImplementation(async () => new Map());
    const res = await call("/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { name: string; version: string | null }[];
    };
    const attio = body.tools.find((t) => t.name === "attio_query_records");
    expect(attio?.version).toBeNull();
    resolveToolVersions.mockImplementation(
      async () => new Map([["attio_query_records", "0.1.7"]]),
    );
  });

  it("renders a hub-backed tool (no registry tarball) with version: null on the list", async () => {
    context = { tenantId: "tenant-1" };
    forbidden = false;
    const res = await call("/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { name: string; version: string | null }[];
    };
    const hubTool = body.tools.find((t) => t.name === "list_artifacts");
    expect(hubTool?.version).toBeNull();
  });

  it("returns version: null on the detail endpoint for a hub-backed tool", async () => {
    context = { tenantId: "tenant-1" };
    forbidden = false;
    const res = await call("/tools/list_artifacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tool: { name: string; version: string | null };
    };
    expect(body.tool.name).toBe("list_artifacts");
    expect(body.tool.version).toBeNull();
  });
});
