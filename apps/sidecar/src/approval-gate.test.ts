import { describe, expect, test } from "bun:test";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRunner,
} from "@intx/types/runtime";
import {
  APPROVAL_GATED_TOOLS,
  createApprovalClient,
  createApprovalGatedRunner,
} from "./approval-gate";

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

const DEF: ToolDefinition = {
  name: "vercel_deploy_static_file",
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
  test("passes ungated tools straight through without asking for approval", async () => {
    const inner = innerRunner();
    let approveCalled = false;
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["vercel_deploy_static_file"]),
      approve: async () => {
        approveCalled = true;
        return { approved: true };
      },
    });

    const result = await runner.run(
      call("vercel_list_projects"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(inner.calls).toHaveLength(1);
    expect(approveCalled).toBe(false);
  });

  test("runs a gated tool only after approval", async () => {
    const inner = innerRunner();
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["vercel_deploy_static_file"]),
      approve: async () => ({ approved: true }),
    });

    const result = await runner.run(
      call("vercel_deploy_static_file"),
      new AbortController().signal,
    );

    expect(result.content).toBe("deployed");
    expect(inner.calls).toHaveLength(1);
  });

  test("gates vercel_deploy_artifact the same as static file deploy", async () => {
    const inner = innerRunner();
    let approved = false;
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["vercel_deploy_artifact"]),
      approve: async () => {
        approved = true;
        return { approved: true };
      },
    });

    const result = await runner.run(
      call("vercel_deploy_artifact"),
      new AbortController().signal,
    );

    expect(approved).toBe(true);
    expect(result.isError).toBe(false);
    expect(inner.calls).toHaveLength(1);
  });

  test("ships both Vercel write tools in the production gated set", () => {
    expect(APPROVAL_GATED_TOOLS.has("vercel_deploy_static_file")).toBe(true);
    expect(APPROVAL_GATED_TOOLS.has("vercel_deploy_artifact")).toBe(true);
  });

  test("blocks a gated tool when approval is rejected and never runs it", async () => {
    const inner = innerRunner();
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["vercel_deploy_static_file"]),
      approve: async () => ({ approved: false, message: "nope" }),
    });

    const result = await runner.run(
      call("vercel_deploy_static_file"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "vercel_deploy_static_file was not approved: nope",
    });
    expect(inner.calls).toHaveLength(0);
  });

  test("blocks (does not run) when the approval request errors", async () => {
    const inner = innerRunner();
    const runner = createApprovalGatedRunner(inner, {
      gatedTools: new Set(["vercel_deploy_static_file"]),
      approve: async () => {
        throw new Error("hub down");
      },
    });

    const result = await runner.run(
      call("vercel_deploy_static_file"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(inner.calls).toHaveLength(0);
  });
});

describe("createApprovalClient", () => {
  test("creates a record and resolves approved once a human approves", async () => {
    const seen: { url: string; method: string }[] = [];
    const fetcher = (async (url, init) => {
      seen.push({ url: String(url), method: String(init?.method) });
      if (init?.method === "POST")
        return json({ id: "apr_1", status: "pending", message: null });
      return json({ id: "apr_1", status: "approved", message: null });
    }) as typeof fetch;

    const approve = createApprovalClient(CTX, { fetcher, pollIntervalMs: 1 });
    const decision = await approve(
      call("vercel_deploy_static_file"),
      new AbortController().signal,
    );

    expect(decision).toEqual({ approved: true });
    expect(seen[0]).toEqual({
      url: "https://hub.example.com/api/internal/approvals",
      method: "POST",
    });
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
    })(call("vercel_deploy_static_file"), new AbortController().signal);

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
        call("vercel_deploy_static_file"),
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
    })(call("vercel_deploy_static_file"), controller.signal);

    expect(decision).toEqual({
      approved: false,
      message: "approval request was cancelled",
    });
  });
});
