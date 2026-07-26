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
  for (const method of [
    "from",
    "where",
    "orderBy",
    "innerJoin",
    "for",
    "limit",
  ]) {
    chain[method] = () => chain;
  }
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
  // Counts db.transaction() entries — a proxy for "the tool handler actually
  // executed" in tests that assert a blocked call never runs the tool.
  counters?: { transactions: number };
};

function fakeDb(opts: DbOpts): Parameters<typeof createHubToolsRouter>[0] {
  return {
    select: () => chainableSelect(opts.selectRows ?? []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (opts.counters) opts.counters.transactions += 1;
      return fn({ select: () => chainableSelect(opts.selectRows ?? []) });
    },
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

  // write_artifact is a structured (kind: "full") tool — the shape every
  // workflow persist step reaches through this rail. The route must execute
  // full handlers and return their structured content INTACT: downstream
  // selectors consume the step output's `content` as an object (heartbeat's
  // notify-prep merges persist.output.content), so flattening to a JSON
  // string breaks every such consumer with "merge selector requires each
  // operand to be an object" — the production failure this pins.
  test("executes a kind-full tool (write_artifact), returning structured content intact", async () => {
    const insertChain = () => ({
      values: (row: Record<string, unknown>) => {
        const p: Record<string, unknown> = {
          returning: async () => [{ id: "art-1", ...row }],
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        };
        return p;
      },
    });
    const db = fakeDb({
      toolNames: ["@workbench/tools-artifact/artifact:write_artifact"],
    }) as unknown as Record<string, unknown>;
    const tx = {
      select: () => chainableSelect([]),
      insert: insertChain,
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    db.transaction = async (fn: (t: unknown) => Promise<unknown>) => fn(tx);
    const router = createHubToolsRouter(
      db as Parameters<typeof createHubToolsRouter>[0],
      "sidecar-token",
    );
    const res = await post(router, {
      ...baseCall,
      toolName: "write_artifact",
      args: { title: "Digest", body: "hello", kind: "research" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: string;
      structuredResult?: unknown;
      isError: boolean;
    };
    expect(body.isError).toBe(false);
    // Additive wire shape: `result` keeps the text form for stale clients;
    // `structuredResult` carries the object verbatim for updated ones.
    expect(body.structuredResult).toEqual({
      artifactId: "art-1",
      version: 1,
      title: "Digest",
    });
    expect(JSON.parse(body.result)).toEqual(body.structuredResult);
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

  // Repeating an IDENTICAL failing call (same tool + same args) must escalate:
  // a corrective hint on the 2nd consecutive failure, a hard stop on the 3rd,
  // and the call blocked before execution afterwards. artifact_create with a
  // missing title is exactly the observed production loop.
  describe("identical failing call loop guard", () => {
    const failingCall = {
      ...baseCall,
      toolName: "artifact_create",
      args: { kind: "note", content: "c" },
    };

    async function runToolBody(
      router: ReturnType<typeof createHubToolsRouter>,
      body: unknown,
    ): Promise<{ result: string; isError: boolean }> {
      const res = await post(router, body);
      expect(res.status).toBe(200);
      return (await res.json()) as { result: string; isError: boolean };
    }

    test("appends an escalating hint on the 2nd identical failure and blocks on the 3rd", async () => {
      const router = makeRouter(["artifact_create", "artifact_list"]);

      const first = await runToolBody(router, failingCall);
      expect(first.isError).toBe(true);
      expect(first.result).not.toContain("times in a row");

      const second = await runToolBody(router, failingCall);
      expect(second.isError).toBe(true);
      expect(second.result).toContain("title is required");
      expect(second.result).toContain("2 times in a row");

      const third = await runToolBody(router, failingCall);
      expect(third.isError).toBe(true);
      expect(third.result).toContain("blocked");

      // Past the ceiling the call is refused without executing the tool.
      const fourth = await runToolBody(router, failingCall);
      expect(fourth.isError).toBe(true);
      expect(fourth.result).toContain("blocked");
    });

    test("a blocked call is refused without executing the tool", async () => {
      // artifact_write reaches db.transaction before failing (artifact not
      // found), so the transaction count measures actual handler executions.
      const counters = { transactions: 0 };
      const router = createHubToolsRouter(
        fakeDb({ toolNames: ["artifact_write"], counters }),
        "sidecar-token",
      );
      const call = {
        ...baseCall,
        toolName: "artifact_write",
        args: { artifactId: "gone", content: "x" },
      };

      for (let i = 0; i < 3; i += 1) {
        const body = await runToolBody(router, call);
        expect(body.isError).toBe(true);
      }
      expect(counters.transactions).toBe(3);

      const blocked = await runToolBody(router, call);
      expect(blocked.result).toContain("blocked");
      expect(counters.transactions).toBe(3);
    });

    test("different args reset the run", async () => {
      const router = makeRouter(["artifact_create"]);
      await runToolBody(router, failingCall);
      await runToolBody(router, {
        ...failingCall,
        args: { kind: "other", content: "c" },
      });
      const next = await runToolBody(router, failingCall);
      expect(next.result).not.toContain("times in a row");
    });

    test("a success resets the run", async () => {
      const router = makeRouter(["artifact_create", "artifact_list"]);
      await runToolBody(router, failingCall);
      const ok = await runToolBody(router, {
        ...baseCall,
        toolName: "artifact_list",
        args: {},
      });
      expect(ok.isError).toBe(false);
      const next = await runToolBody(router, failingCall);
      expect(next.isError).toBe(true);
      expect(next.result).not.toContain("times in a row");
    });

    test("sessions are tracked independently", async () => {
      const router = makeRouter(["artifact_create"]);
      await runToolBody(router, failingCall);
      const otherSession = await runToolBody(router, {
        ...failingCall,
        sessionId: "s2",
      });
      expect(otherSession.result).not.toContain("times in a row");
    });
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
