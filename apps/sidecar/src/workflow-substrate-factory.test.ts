// Proves the sidecar's parent-step invoker runs the REAL agent harness
// (a real `agent.send`) rather than the upstream reference sidecar's
// canned stub (`{ reply: req.agent.id, turn: null }`). A stub
// `agentFactory` stands in for the reactor assembly so the test does not
// require a live inference source; the assertion is on the invoker's
// observable output (the agent's reply + turn), not on the mock.

import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, AgentDefinition, BaseEnv } from "@intx/agent";

// The assistant turn shape, derived from Agent.send rather than imported by
// name — @intx/agent does not re-export ConversationTurn from its barrel.
type SendTurn = Awaited<ReturnType<Agent["send"]>>["turn"];
import { createDefaultDirectorRegistry } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import type { GrantEvaluator } from "@intx/workflow-host";
import type { StepInvokeRequest } from "@intx/workflow";

import { createSidecarStepInvoker } from "./workflow-substrate-factory";
import type { StepToolContext } from "./step-tool-harness";

const tmpDirs: string[] = [];
const realFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

// Empty hub manifest + no credentials: the step loads only its local posix
// tools, enough to dispatch `write_file` through the deterministic branch.
function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/internal/tools/manifest")) {
      return new Response(
        JSON.stringify({
          manifest: { schemaVersion: "1", topLevel: [], entries: [] },
          tarballs: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/internal/tools/credentials")) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-step-invoker-"));
  tmpDirs.push(dir);
  return dir;
}

const STEP_ID = "draft";
const RUN_ID = "run-abc";
const SOURCE: InferenceSource = {
  id: "src-1",
  provider: "openai-compatible",
  baseURL: "https://example.invalid",
  apiKey: "sk-test",
  model: "test-model",
};

function makeAgentDefinition(id: string): AgentDefinition<BaseEnv> {
  return {
    id,
    systemPrompt: "you are a test agent",
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
  };
}

function makeRequest(): StepInvokeRequest {
  return {
    agent: makeAgentDefinition("agent-under-test"),
    input: { topic: "launch announcement" },
    authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
    signal: new AbortController().signal,
  };
}

const allowAll: GrantEvaluator = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

describe("createSidecarStepInvoker", () => {
  test("returns the real agent's reply, not the upstream stub shape", async () => {
    const dataDir = await makeDataDir();
    const REPLY = "Here is the drafted announcement.";
    const turn = {
      role: "assistant",
      content: REPLY,
    } as unknown as SendTurn;

    let sentContent: string | undefined;
    let closed = false;
    const stubAgent: Agent = {
      send: async (content: Parameters<Agent["send"]>[0]) => {
        sentContent = typeof content === "string" ? content : content.content;
        return { reply: REPLY, turn };
      },
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {
        closed = true;
      },
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "test-signature",
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => stubAgent,
    });

    const result = await invoke(makeRequest());

    expect(result.output).toEqual({ reply: REPLY, turn });
    // Guard against regressing to the upstream stub, which echoed the
    // agent id with a null turn.
    expect(result.output).not.toEqual({
      reply: "agent-under-test",
      turn: null,
    });
    // The step's resolved input reached the agent's send path.
    expect(sentContent).toBe(JSON.stringify({ topic: "launch announcement" }));
    // The invoker tore the agent down on the success path.
    expect(closed).toBe(true);
  });

  test("builds a real per-step BaseEnv (storage/workdir/audit/directors) for the agent factory", async () => {
    const dataDir = await makeDataDir();
    let capturedEnv: BaseEnv | undefined;
    const stubAgent: Agent = {
      send: async () => ({
        reply: "ok",
        turn: { role: "assistant", content: "ok" } as unknown as SendTurn,
      }),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    const directors = createDefaultDirectorRegistry();
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "sig",
      directors,
      evaluateGrants: allowAll,
      agentFactory: async (_def, env) => {
        capturedEnv = env;
        return stubAgent;
      },
    });

    await invoke(makeRequest());

    expect(capturedEnv).toBeDefined();
    const env = capturedEnv as BaseEnv;
    expect(env.sources).toEqual([SOURCE]);
    expect(env.defaultSource).toBe(SOURCE.id);
    expect(env.directors).toBe(directors);
    // workdir is a real, created directory under the per-run/per-step root.
    const stat = await fs.stat(env.workdir);
    expect(stat.isDirectory()).toBe(true);
    expect(env.workdir).toContain(RUN_ID);
    expect(env.workdir).toContain(STEP_ID);
    // storage + audit are the same per-step isogit store (mirrors default-harness).
    expect(env.audit).toBe(env.storage as unknown as typeof env.audit);
  });

  test("rejects a step request missing runId before building an agent", async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error("should not reach the agent factory");
      },
    });

    const req: StepInvokeRequest = {
      agent: makeAgentDefinition("a"),
      input: {},
      authzContext: { stepId: STEP_ID, attempt: 1 },
      signal: new AbortController().signal,
    };

    await expect(invoke(req)).rejects.toThrow(/runId is required/);
    expect(factoryCalled).toBe(false);
  });

  test("routes a deterministic-tool-tagged step away from the inference agent factory", async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error(
          "inference factory must not run for a deterministic step",
        );
      },
    });

    const detAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition("deterministic-gamma_create_from_template"),
      tags: {
        "workbench.stepKind": "deterministic-tool",
        "workbench.tool": "gamma_create_from_template",
      },
    };
    const req: StepInvokeRequest = {
      agent: detAgent,
      input: { foo: "bar" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    // The deterministic branch builds the step env and dispatches to the tool
    // handler; with no resolveStepToolContext wired (pure-dispatch test), the
    // handler fails loud on the missing tool context. The key assertion is
    // that the INFERENCE factory was never consulted — the marker rerouted it.
    await expect(invoke(req)).rejects.toThrow(/STEP_TOOL_CONTEXT/);
    expect(factoryCalled).toBe(false);
  });

  test("an unmarked step still reaches the inference agent factory", async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const stubAgent: Agent = {
      send: async () => ({
        reply: "ok",
        turn: { role: "assistant", content: "ok" } as unknown as SendTurn,
      }),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        return stubAgent;
      },
    });

    await invoke(makeRequest());
    expect(factoryCalled).toBe(true);
  });

  // Regression (greybeard/critique): a `map({ over, step: deterministicToolStep })`
  // dispatches each per-element invocation through the deterministic branch, not
  // inference. The runtime calls the step invoker once per element with the same
  // deterministic-tagged step request shape, so we drive `invoke` per element and
  // assert: the real tool runner ran once per element (a file written per item)
  // and the inference agent factory was never constructed.
  test("dispatches a per-element map invocation through the deterministic tool branch, never inference", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const resolveStepToolContext = async (
      req: StepInvokeRequest,
    ): Promise<StepToolContext> => {
      const stepId = req.authzContext.stepId ?? "step";
      return {
        hubHttpUrl: "http://hub.invalid",
        sidecarToken: "tok",
        tenantId: "ten_1",
        stepAgentId: `ins_dep-${stepId}`,
        stepAddress: `ins_dep-${stepId}`,
        principalId: `ins_dep-${stepId}`,
        grants: [],
        cacheRoot: path.join(dataDir, "cache"),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      };
    };
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      resolveStepToolContext,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error(
          "inference factory must not run for a map of det steps",
        );
      },
    });

    const detAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition("deterministic-write_file"),
      tags: {
        "workbench.stepKind": "deterministic-tool",
        "workbench.tool": "write_file",
      },
    };

    // `map` invokes the step invoker once per element; each element gets a
    // distinct per-attempt store. Drive them sequentially with a per-element
    // attempt so the per-step store teardown does not race (a test-harness
    // concern, not a product one) and assert every element dispatched through
    // the deterministic tool branch.
    const elements = ["a.txt", "b.txt", "c.txt"];
    const outputs: { output: unknown }[] = [];
    for (let i = 0; i < elements.length; i += 1) {
      const name = elements[i] as string;
      outputs.push(
        await invoke({
          agent: detAgent,
          input: { path: name, content: `content-${name}` },
          authzContext: { stepId: STEP_ID, attempt: i + 1, runId: RUN_ID },
          signal: new AbortController().signal,
        }),
      );
    }

    // No agent was constructed for any element.
    expect(factoryCalled).toBe(false);
    // The tool runner produced a ToolResult envelope per element.
    expect(outputs).toHaveLength(elements.length);
    for (const { output } of outputs) {
      const tr = output as Record<string, unknown>;
      expect(tr).toHaveProperty("callId");
      expect(tr.isError).not.toBe(true);
    }
  });
});
