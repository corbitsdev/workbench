import { describe, expect, test } from "bun:test";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRunner,
} from "@intx/types/runtime";
import {
  createApprovalClient,
  createApprovalGatedRunner,
} from "./approval-gate";

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

const DEF: ToolDefinition = {
  name: "vercel__deploy_static_file",
  description: "deploy",
  inputSchema: { type: "object", properties: {} },
};

function innerRunner(): DefinedRunner & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    definitions: [DEF],
    async run(call: ToolCall): Promise<ToolResult> {
      calls.push(call);
      return { callId: call.id, content: "deployed", isError: false };
    },
  };
}

function call(name: string): ToolCall {
  return { id: "call_1", name, arguments: { projectName: "demo" } };
}

const CTX = {
  hubHttpUrl: "https://hub.example.com",
  sidecarToken: "tok",
  tenantId: "tnt_1",
  agentId: "agt_1",
  principalId: "prn_1",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApprovalGatedRunner", () => {
  test("passes ungated (read) tools straight through without asking", async () => {
    const inner = innerRunner();
    let approveCalled = false;
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["notion__create_page"]),
      approve: async () => {
        approveCalled = true;
        return { approved: true };
      },
    });

    const result = await runner.run(
      call("notion__search"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(inner.calls).toHaveLength(1);
    expect(approveCalled).toBe(false);
  });

  test("prompts for a gated write tool and forwards the concrete arguments", async () => {
    const inner = innerRunner();
    let seen: ToolCall | undefined;
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["notion__create_page"]),
      approve: async (c) => {
        seen = c;
        return { approved: true };
      },
    });

    const result = await runner.run(
      call("notion__create_page"),
      new AbortController().signal,
    );

    expect(result.content).toBe("deployed");
    expect(inner.calls).toHaveLength(1);
    // The whole point of the runner seam: the approval sees the real args so
    // ReviewGate can show the human what will run.
    expect(seen?.arguments).toEqual({ projectName: "demo" });
  });

  test("blocks a gated tool when approval is rejected and never runs it", async () => {
    const inner = innerRunner();
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["notion__create_page"]),
      approve: async () => ({ approved: false, message: "nope" }),
    });

    const result = await runner.run(
      call("notion__create_page"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "notion__create_page was not approved: nope",
    });
    expect(inner.calls).toHaveLength(0);
  });

  test("blocks (does not run) when the approval request errors/times out", async () => {
    const inner = innerRunner();
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["notion__create_page"]),
      approve: async () => {
        throw new Error("hub down");
      },
    });

    const result = await runner.run(
      call("notion__create_page"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(inner.calls).toHaveLength(0);
  });
});

describe("createApprovalClient", () => {
  test("creates a record carrying the tool arguments, resolves approved once a human approves", async () => {
    const seen: { url: string; method: string; body?: unknown }[] = [];
    const fetcher = (async (url, init) => {
      seen.push({
        url: String(url),
        method: String(init?.method),
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (init?.method === "POST")
        return json({ id: "apr_1", status: "pending", message: null });
      return json({ id: "apr_1", status: "approved", message: null });
    }) as typeof fetch;

    const approve = createApprovalClient(CTX, { fetcher, pollIntervalMs: 1 });
    const decision = await approve(
      call("notion__create_page"),
      new AbortController().signal,
    );

    expect(decision).toEqual({ approved: true });
    expect(seen[0]).toMatchObject({
      url: "https://hub.example.com/api/internal/approvals",
      method: "POST",
    });
    // The approval record must carry the concrete tool arguments (F1 pivot):
    // ReviewGate shows the human the exact action.
    expect(
      (seen[0]?.body as { context?: unknown } | undefined)?.context,
    ).toEqual({ projectName: "demo" });
    expect(seen[1]?.url).toBe(
      "https://hub.example.com/api/internal/approvals/apr_1?tenantId=tnt_1",
    );
  });

  test("keeps waiting through a transient hub error", async () => {
    let gets = 0;
    const fetcher = (async (_url, init) => {
      if (init?.method === "POST")
        return json({ id: "apr_1", status: "pending", message: null });
      gets += 1;
      if (gets === 1) return json({ error: "bad gateway" }, 503);
      return json({ id: "apr_1", status: "approved", message: null });
    }) as typeof fetch;

    const decision = await createApprovalClient(CTX, {
      fetcher,
      pollIntervalMs: 1,
    })(call("notion__create_page"), new AbortController().signal);

    expect(decision).toEqual({ approved: true });
    expect(gets).toBe(2);
  });

  test("throws on a permanent (404) poll fault", async () => {
    const fetcher = (async (_url, init) =>
      init?.method === "POST"
        ? json({ id: "apr_1", status: "pending", message: null })
        : json({ error: "gone" }, 404)) as typeof fetch;

    await expect(
      createApprovalClient(CTX, { fetcher, pollIntervalMs: 1 })(
        call("notion__create_page"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("404");
  });

  test("returns cancelled when the signal is already aborted", async () => {
    const fetcher = (async (_url, init) => {
      if (init?.method === "POST")
        return json({ id: "apr_1", status: "pending", message: null });
      throw new Error("should not poll after cancel");
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    const decision = await createApprovalClient(CTX, {
      fetcher,
      pollIntervalMs: 1,
    })(call("notion__create_page"), controller.signal);

    expect(decision).toEqual({
      approved: false,
      message: "approval request was cancelled",
    });
  });
});
