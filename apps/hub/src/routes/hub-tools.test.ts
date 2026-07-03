import { describe, expect, test } from "bun:test";
// The hub tool modules carry an import cycle (tool-registry →
// file-parser-tools → services/file-parser → services/agent-provisioning →
// tool-registry). Entering it via ./hub-tools (→ hub-backed-tools →
// file-parser-tools) trips a TDZ on FILEPARSER_HUB_TOOLS and kills this
// whole file before any test runs; entering via tool-registry first
// resolves cleanly. Anchor the evaluation order.
import "../lib/tool-registry";
import { createHubToolsRouter } from "./hub-tools";

// artifact_list issues `db.select({...}).from().where().orderBy().limit()`,
// resolving to a rows array. This chainable fake satisfies that path so the
// authorized happy-path test exercises a real hub-backed tool end to end
// without mocking @intx/db.
function chainableSelect(rows: unknown[]): unknown {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "innerJoin"]) {
    chain[method] = () => chain;
  }
  chain.limit = async () => rows;
  // gamma_list_templates awaits the chain directly after `.orderBy()`, so the
  // fake is also thenable, resolving to the same rows.
  chain.then = (resolve: (value: unknown[]) => void) => resolve(rows);
  return chain;
}

type DbOpts = {
  toolNames: string[];
  agentTenantId?: string;
  instanceMatches?: boolean;
  creatorPrincipalId?: string;
  selectRows?: unknown[];
};

function fakeDb(opts: DbOpts): Parameters<typeof createHubToolsRouter>[0] {
  return {
    select: () => chainableSelect(opts.selectRows ?? []),
    query: {
      agent: {
        findFirst: async () => ({
          tenantId: opts.agentTenantId ?? "t1",
          creatorPrincipalId: opts.creatorPrincipalId ?? "owner1",
          capabilities: { tools: opts.toolNames },
        }),
      },
      agentInstance: {
        findFirst: async () =>
          (opts.instanceMatches ?? true)
            ? { id: "i1", principalId: "instance-owner" }
            : undefined,
      },
    },
  } as unknown as Parameters<typeof createHubToolsRouter>[0];
}

function makeRouter(
  toolNames: string[],
  extra: Omit<DbOpts, "toolNames"> = {},
) {
  return createHubToolsRouter(fakeDb({ toolNames, ...extra }), "sidecar-token");
}

function post(
  router: ReturnType<typeof createHubToolsRouter>,
  body: unknown,
  token = "sidecar-token",
) {
  return router.request("/hub-tools/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const baseCall = {
  tenantId: "t1",
  agentId: "a1",
  principalId: "p1",
  sessionId: "s1",
  args: {},
};

describe("POST /hub-tools/run", () => {
  test("rejects an unauthorized caller", async () => {
    const res = await post(
      makeRouter(["artifact_list"]),
      { ...baseCall, toolName: "artifact_list" },
      "wrong",
    );
    expect(res.status).toBe(401);
  });

  test("executes a hub-backed tool the agent is granted", async () => {
    const res = await post(makeRouter(["artifact_list"]), {
      ...baseCall,
      toolName: "artifact_list",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; isError: boolean };
    expect(body.isError).toBe(false);
    expect(JSON.parse(body.result)).toEqual({ artifacts: [] });
  });

  // CL-2597: gamma_list_templates must be dispatchable over this hub-backed
  // rail (the one workflow steps reach through defineHubBackedToolPackage),
  // not only over the legacy session-token proxy. The prefixed canonical
  // capability must authorize the bare hub-tool name, and the REAL
  // listLatestGammaTemplates projection runs over the fake driver rows.
  test("executes gamma_list_templates as a hub-backed tool (CL-2597)", async () => {
    const res = await post(
      makeRouter(
        ["@workbench/tools-gamma/gamma-templates:gamma_list_templates"],
        {
          selectRows: [
            {
              id: "tpl-1",
              version: 3,
              name: "Sales Deck",
              config: { gammaId: "g-1", description: "Quarterly sales deck" },
              authorId: "prn-author",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        },
      ),
      { ...baseCall, toolName: "gamma_list_templates" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; isError: boolean };
    expect(body.isError).toBe(false);
    expect(JSON.parse(body.result)).toEqual([
      {
        gammaId: "g-1",
        name: "Sales Deck",
        description: "Quarterly sales deck",
      },
    ]);
  });

  test("rejects a tool not in the agent capabilities with 403", async () => {
    const res = await post(makeRouter(["artifact_read"]), {
      ...baseCall,
      toolName: "artifact_list",
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for a tool that is not hub-backed", async () => {
    const res = await post(makeRouter(["hackernews_search"]), {
      ...baseCall,
      toolName: "hackernews_search",
    });
    expect(res.status).toBe(404);
  });

  test("rejects when the agent belongs to a different tenant (403)", async () => {
    const res = await post(
      makeRouter(["artifact_list"], { agentTenantId: "other" }),
      {
        ...baseCall,
        toolName: "artifact_list",
      },
    );
    expect(res.status).toBe(403);
  });

  test("rejects a principalId that is not an instance of this agent (403)", async () => {
    const res = await post(
      makeRouter(["artifact_list"], { instanceMatches: false }),
      {
        ...baseCall,
        toolName: "artifact_list",
      },
    );
    expect(res.status).toBe(403);
  });

  test("allows deterministic workflow step agents without an instance row", async () => {
    const res = await post(
      makeRouter(["artifact_list"], { instanceMatches: false }),
      {
        ...baseCall,
        agentId: "ins_ses_123-persist",
        principalId: "ins_ses_123-persist",
        toolName: "artifact_list",
      },
    );
    expect(res.status).toBe(200);
  });
});
