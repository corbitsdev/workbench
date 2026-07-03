import { describe, expect, mock, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { HubDb } from "../db";
import type { RunState } from "../workflow-executor/run-store";

// The routes/tools walk the tenant chain via getAncestorChain; everything else
// from @intx/db is preserved so sibling suites keep the real exports.
const realDb = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...realDb,
  getAncestorChain: async () => ["tn-1"],
}));

// In-memory run-store, mirroring the workflow-run-records route test: the row
// is the durable record; the tool handlers must go through these exact
// functions (via the shared run-exec service) or the tests fail.
const runs = new Map<string, RunState>();
mock.module("../workflow-executor/run-store", () => ({
  setRunStatus: async (
    _db: unknown,
    runId: string,
    status: RunState["status"],
  ) => {
    const found = runs.get(runId);
    if (found) runs.set(runId, { ...found, status });
  },
  insertRunRecord: async (
    _db: unknown,
    args: {
      runId: string;
      deploymentId: string | null;
      kind: string;
      tenantId: string;
      principalId: string;
      input: unknown;
      originConversationId: string | null;
    },
  ) => {
    const state: RunState = {
      runId: args.runId,
      kind: args.kind,
      tenantId: args.tenantId,
      principalId: args.principalId,
      status: "running",
      ...(args.deploymentId !== null
        ? { deploymentId: args.deploymentId }
        : {}),
      ...(args.originConversationId !== null
        ? { originConversationId: args.originConversationId }
        : {}),
    };
    runs.set(state.runId, { ...state });
    return state;
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    return found ? { ...found } : null;
  },
  listRunRecords: async (
    _db: unknown,
    _tenantIds: readonly string[],
    principalId: string,
    kind?: string,
    filters?: { originConversationId?: string },
  ) =>
    [...runs.values()]
      .filter((r) => r.principalId === principalId)
      .filter((r) => kind === undefined || r.kind === kind)
      .filter(
        (r) =>
          filters?.originConversationId === undefined ||
          r.originConversationId === filters.originConversationId,
      )
      .map((r) => ({
        runId: r.runId,
        kind: r.kind,
        status: r.status,
        createdAt: new Date(),
        originConversationId: r.originConversationId ?? null,
      })),
  markRunStopped: async () => undefined,
  softDeleteRunRecord: async () => undefined,
}));

const { WORKFLOWS_HUB_TOOLS } = await import("./workflow-run-tools");

// The Myra instance calling the tool: instance principal prn-instance, owned by
// member prn-member through Myra thread (conversation) thread-1.
function fakeDb(): HubDb {
  return {
    query: {
      agentInstance: {
        findFirst: async () => ({
          id: "inst-1",
          agentId: "agent-1",
          tenantId: "tn-1",
          principalId: "prn-instance",
        }),
      },
      memberAgentInstance: {
        findFirst: async () => ({
          id: "thread-1",
          instanceId: "inst-1",
          tenantId: "tn-1",
          memberPrincipalId: "prn-member",
        }),
      },
      workflowRun: {
        findMany: async () => [
          {
            kind: "smoke-test",
            tenantId: "tn-1",
            deploymentId: "dep-registry",
            principalId: "prn-deployer",
            createdAt: new Date(),
          },
        ],
      },
    },
  } as unknown as HubDb;
}

function makeContext(overrides?: {
  sendUserMessage?: (args: Record<string, unknown>) => Promise<void>;
  sendSignalDeliver?: (args: Record<string, unknown>) => void;
}) {
  return {
    db: fakeDb(),
    tenantId: "tn-1",
    agentId: "agent-1",
    principalId: "prn-instance",
    sessionId: "ses-1",
    sessionService: {
      sendUserMessage: overrides?.sendUserMessage ?? (async () => undefined),
    } as never,
    sidecarRouter: {
      sendSignalDeliver: overrides?.sendSignalDeliver ?? (() => undefined),
    } as never,
    cryptoProvider: {} as never,
    deploymentDomain: "test.dev",
    provisionRunDeployment: async () => ({ deploymentId: "dep-run-1" }),
    ensureDeploymentRoutable: async () => ({ reestablished: false }),
  };
}

function getTool(name: string, context: ReturnType<typeof makeContext>) {
  const entry = WORKFLOWS_HUB_TOOLS[name];
  if (!entry) throw new Error(`missing hub tool entry: ${name}`);
  const tool = entry
    .createTools(context)
    .find((t: AgentTool) => t.definition.name === name);
  if (!tool || tool.kind !== "string")
    throw new Error(`missing string tool: ${name}`);
  return tool;
}

describe("workflow_start", () => {
  test("starts a run owned by the calling member with the conversation threaded as originConversationId", async () => {
    runs.clear();
    const sent: Record<string, unknown>[] = [];
    const context = makeContext({
      sendUserMessage: async (args) => {
        sent.push(args);
      },
    });
    const tool = getTool("workflow_start", context);
    const raw = await tool.handler(
      { kind: "smoke-test", input: { topic: "q3" } },
      new AbortController().signal,
    );
    const result = JSON.parse(raw) as {
      runId: string;
      status: string;
      originConversationId?: string;
    };
    expect(result.runId).toMatch(/^wfr_/);
    expect(result.status).toBe("running");
    expect(result.originConversationId).toBe("thread-1");

    const record = runs.get(result.runId);
    if (!record) throw new Error("run record not inserted");
    expect(record.principalId).toBe("prn-member");
    expect(record.originConversationId).toBe("thread-1");
    expect(record.deploymentId).toBe("dep-run-1");

    // The trigger mail is what actually starts the run; its messageId is the
    // runId (the supervisor derives the run id from it).
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messageId).toBe(result.runId);
    expect(sent[0]?.content).toBe(JSON.stringify({ topic: "q3" }));
  });
});

describe("workflow_list_runs", () => {
  test("scopes to the calling member and defaults to the current conversation", async () => {
    runs.clear();
    runs.set("wfr_a", {
      runId: "wfr_a",
      kind: "smoke-test",
      tenantId: "tn-1",
      principalId: "prn-member",
      status: "running",
      originConversationId: "thread-1",
    });
    runs.set("wfr_b", {
      runId: "wfr_b",
      kind: "smoke-test",
      tenantId: "tn-1",
      principalId: "prn-member",
      status: "completed",
      originConversationId: "thread-other",
    });
    runs.set("wfr_c", {
      runId: "wfr_c",
      kind: "smoke-test",
      tenantId: "tn-1",
      principalId: "prn-someone-else",
      status: "running",
      originConversationId: "thread-1",
    });

    const context = makeContext();
    const tool = getTool("workflow_list_runs", context);

    const scoped = JSON.parse(
      await tool.handler({}, new AbortController().signal),
    ) as { runs: { runId: string }[] };
    expect(scoped.runs.map((r) => r.runId)).toEqual(["wfr_a"]);

    const all = JSON.parse(
      await tool.handler(
        { allConversations: true },
        new AbortController().signal,
      ),
    ) as { runs: { runId: string }[] };
    expect(all.runs.map((r) => r.runId).sort()).toEqual(["wfr_a", "wfr_b"]);
  });
});

describe("workflow_signal", () => {
  test("delivers the gate signal to the run's deployment and flips it to running", async () => {
    runs.clear();
    runs.set("wfr_gated", {
      runId: "wfr_gated",
      kind: "smoke-test",
      tenantId: "tn-1",
      principalId: "prn-member",
      status: "awaiting",
      deploymentId: "dep-9",
      originConversationId: "thread-1",
    });

    const delivered: Record<string, unknown>[] = [];
    const context = makeContext({
      sendSignalDeliver: (args) => {
        delivered.push(args);
      },
    });
    const tool = getTool("workflow_signal", context);
    const result = JSON.parse(
      await tool.handler(
        { runId: "wfr_gated", signalName: "approve", payload: { ok: true } },
        new AbortController().signal,
      ),
    ) as { status: string };
    expect(result.status).toBe("running");
    expect(runs.get("wfr_gated")?.status).toBe("running");

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.runId).toBe("wfr_gated");
    expect(delivered[0]?.signalName).toBe("approve");
    expect(delivered[0]?.payload).toEqual({ ok: true });
  });

  test("refuses to signal a run the calling member does not own", async () => {
    runs.clear();
    runs.set("wfr_theirs", {
      runId: "wfr_theirs",
      kind: "smoke-test",
      tenantId: "tn-1",
      principalId: "prn-someone-else",
      status: "awaiting",
      deploymentId: "dep-9",
    });
    const tool = getTool("workflow_signal", makeContext());
    await expect(
      tool.handler(
        { runId: "wfr_theirs", signalName: "approve" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/forbidden/i);
  });
});
