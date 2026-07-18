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
import { evaluateGrants } from "@intx/authz";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";
import type { GrantEvaluator } from "@workbench/workflow-host";
import { createWarmAgentCache } from "@workbench/workflow-host";
import type { ChildOutboundMailBridge } from "@workbench/workflow-host";
import type { StepInvokeRequest } from "@intx/workflow";
import type { OutboundMessage, SendReceipt } from "@intx/types/runtime";

import {
  createSidecarStepInvoker,
  createStepInferenceSourceResolver,
  createStepToolContextResolver,
  parseAdapterManifest,
  parseStepInferenceSources,
} from "./workflow-substrate-factory";
import type { Principal, RepoId, RepoStore } from "@intx/hub-sessions";
import {
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";
import {
  createDurableConversationRegistry,
  createDurableConversationStore,
  type DurableConversationRegistry,
  type DurableConversationStore,
} from "./conversation-state";

const tmpDirs: string[] = [];
const realFetch = globalThis.fetch;

describe("createStepInferenceSourceResolver", () => {
  // Each step's pinned value is an ordered failover CHAIN (non-empty array),
  // matching the `AgentDeployFrame` wire contract and the router's
  // `JSON.stringify(spec.sources)`.
  const chain = [
    { provider: "openai-compatible", model: "m" },
  ] as InferenceSource[];
  const other = [
    { provider: "openai-compatible", model: "n" },
  ] as InferenceSource[];
  const failoverChain = [
    { provider: "openai-compatible", model: "primary" },
    { provider: "openai-compatible", model: "backup" },
  ] as InferenceSource[];

  test("resolves a directly-pinned stepId to its full chain", () => {
    const resolve = createStepInferenceSourceResolver({ analyze: chain });
    expect(resolve("analyze")).toEqual(chain);
  });

  test("returns the whole failover chain, not just the head", () => {
    const resolve = createStepInferenceSourceResolver({
      analyze: failoverChain,
    });
    expect(resolve("analyze")).toEqual(failoverChain);
    expect(resolve("analyze")).toHaveLength(2);
  });

  test("falls back a map-expanded stepId to its base step chain", () => {
    // `map` fans out `generate` into `generate[0]`, `generate[1]`, … at run
    // time; those dynamic ids are not in the statically-pinned table, so they
    // must resolve to the base step's pinned chain.
    const resolve = createStepInferenceSourceResolver({ generate: chain });
    expect(resolve("generate[0]")).toEqual(chain);
    expect(resolve("generate[12]")).toEqual(chain);
  });

  test("prefers a direct pin over the base fallback", () => {
    const resolve = createStepInferenceSourceResolver({
      generate: other,
      "generate[0]": chain,
    });
    expect(resolve("generate[0]")).toEqual(chain);
  });

  test("throws when neither the stepId nor its base is pinned", () => {
    const resolve = createStepInferenceSourceResolver({ analyze: chain });
    expect(() => resolve("generate[0]")).toThrow(/no InferenceSource pinned/);
    expect(() => resolve("missing")).toThrow(/no InferenceSource pinned/);
  });
});

describe("parseStepInferenceSources", () => {
  // The wire/router shape is `Record<stepId, InferenceSource[]>`: the deploy
  // router serializes `spec.sources` (arrays) into STEP_INFERENCE_SOURCES.
  // This is the exact payload the workflow-child crashed on when the parser
  // was mistyped to a single `InferenceSource`.
  const wireSource = {
    id: "src-emit",
    provider: "openai-compatible",
    baseURL: "https://example.invalid",
    apiKey: "sk-test",
    model: "test-model",
  };

  test("accepts the router's array-shaped payload (regression)", () => {
    const payload = JSON.stringify({
      emit: [wireSource],
      scrape: [wireSource],
    });
    const parsed = parseStepInferenceSources(payload);
    expect(parsed.emit).toEqual([wireSource]);
    expect(parsed.scrape).toEqual([wireSource]);
  });

  test("rejects a single-object (non-array) source shape", () => {
    // A bare object per step is the mis-shape that silently broke every
    // multi-step child spawn: the parser must demand the array contract.
    const payload = JSON.stringify({ emit: wireSource });
    expect(() => parseStepInferenceSources(payload)).toThrow(
      /STEP_INFERENCE_SOURCES failed validation/,
    );
  });

  test("rejects an empty chain for a step", () => {
    const payload = JSON.stringify({ emit: [] });
    expect(() => parseStepInferenceSources(payload)).toThrow(
      /STEP_INFERENCE_SOURCES failed validation/,
    );
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

// No credentials: the step loads only its local posix tools, enough to
// dispatch `write_file` through the deterministic branch. Tool resolution is
// on-disk now, so the sidecar makes no manifest fetch.
function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "test-signature",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors,
      adapters: createBuiltinRegistry(),
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
    // Cold multi-step path: no summarize compactor registered (CL-3806).
    expect(
      (env as BaseEnv & { compactors?: Record<string, unknown> }).compactors,
    ).toBeUndefined();
  });

  test("warm durable-conversation path registers the summarize compactor (CL-3806)", async () => {
    const dataDir = await makeDataDir();
    const repoDir = await makeDataDir();
    const repoId: RepoId = { kind: "workflow-run", id: "wfr_compactor_test" };
    const principal: Principal = {
      kind: "workflow-process",
      deploymentId: "ses_compactor_test",
    } as unknown as Principal;
    const substrate = createOnDiskSubstrate(repoDir);

    const durableStore = await createDurableConversationStore({
      localStoreDir: path.join(dataDir, "compactor-store"),
      signer: async () => "sig",
      substrate,
      workflowRunRepoId: repoId,
      workflowRunRef: "refs/heads/main",
      principal,
      agentKey: STEP_ID,
    });
    const durableConversation: DurableConversationRegistry = {
      get: () => durableStore,
      acquire: async () => durableStore,
    };

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

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      workflowRunRepoId: repoId,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      durableConversation,
      agentFactory: async (_def, env) => {
        capturedEnv = env;
        return stubAgent;
      },
    });

    await invoke(makeRequest());

    expect(capturedEnv).toBeDefined();
    const compactors = (
      capturedEnv as BaseEnv & {
        compactors?: Record<string, { name?: string }>;
      }
    ).compactors;
    expect(compactors).toBeDefined();
    expect(compactors?.summarize).toBeDefined();
    expect(compactors?.summarize?.name).toBe("summarize");
  });

  test("rejects a step request missing runId before building an agent", async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
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
        // No deploy/ subtree under dataDir → empty on-disk manifest → local
        // (posix) tools only, which is what the deterministic dispatch needs.
        deployTreeDir: dataDir,
        cacheRoot: path.join(dataDir, "cache"),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      };
    };
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
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

  // Inline-inference dispatch (CL-2251). An inline-tagged step is a no-tool
  // single-turn reasoning turn the hub did NOT deploy as a per-step session,
  // so the sidecar runs it with a bare createAgent against the step's pinned
  // STEP_INFERENCE_SOURCES entry — never the tool-capable factory, and the
  // step env carries NO tool context (the hub wrote none for it).
  test("runs an inline-inference-tagged step with the pinned source and no tool context", async () => {
    const dataDir = await makeDataDir();
    const INLINE_REPLY = '{"painPoints":[]}';
    const turn = {
      role: "assistant",
      content: INLINE_REPLY,
    } as unknown as SendTurn;

    let capturedEnv: BaseEnv | undefined;
    let capturedDef: AgentDefinition<BaseEnv> | undefined;
    let sentContent: string | undefined;
    let closed = false;
    const stubAgent: Agent = {
      send: async (content: Parameters<Agent["send"]>[0]) => {
        sentContent = typeof content === "string" ? content : content.content;
        return { reply: INLINE_REPLY, turn };
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

    // No resolveStepToolContext wired — exactly the production inline path.
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async (def, env) => {
        capturedDef = def as AgentDefinition<BaseEnv>;
        capturedEnv = env;
        return stubAgent;
      },
    });

    const inlineAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition("inline-analyze"),
      systemPrompt: "extract pain points and return JSON",
      tags: { "workbench.stepKind": "inline-inference" },
    };
    const req: StepInvokeRequest = {
      agent: inlineAgent,
      input: { transcript: "they hate slow onboarding" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    const result = await invoke(req);

    // The inline branch returned the real agent reply in the {reply,turn} shape.
    expect(result.output).toEqual({ reply: INLINE_REPLY, turn });
    // CONDITION 1: the env's inference source is the pinned STEP_INFERENCE_SOURCES
    // entry for this step — credentials come from the env table, not on-demand.
    const env = capturedEnv as BaseEnv;
    expect(env.sources).toEqual([SOURCE]);
    expect(env.defaultSource).toBe(SOURCE.id);
    // No tool context was stashed on the env: the inline path never builds a
    // tool-capable harness, so createStepAgentFactory's key is absent.
    expect(
      (env as unknown as Record<string, unknown>)[STEP_TOOL_CONTEXT_KEY],
    ).toBeUndefined();
    // The step's real system prompt reached the bare agent factory.
    expect(capturedDef?.systemPrompt).toBe(
      "extract pain points and return JSON",
    );
    // The resolved input reached the agent's send path, JSON-encoded.
    expect(sentContent).toBe(
      JSON.stringify({ transcript: "they hate slow onboarding" }),
    );
    // The inline branch tore the agent down.
    expect(closed).toBe(true);
  });

  // Non-fatal inline steps (the A/B preset quorum): a failed turn degrades to a
  // completed isError output instead of failing the run, so one dead variant
  // does not kill the comparison. A step WITHOUT the tag still throws.
  test("a nonFatal-tagged inline step degrades a failed turn to an isError output", async () => {
    const dataDir = await makeDataDir();
    let closed = false;
    const throwingAgent: Agent = {
      send: async () => {
        throw new Error("provider 503");
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => throwingAgent,
    });

    const nonFatalReq: StepInvokeRequest = {
      agent: {
        ...makeAgentDefinition("inline-variant"),
        tags: {
          "workbench.stepKind": "inline-inference",
          "workbench.nonFatal": "true",
        },
      },
      input: { input: "run it" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    const result = await invoke(nonFatalReq);
    const output = result.output as {
      reply: string;
      isError?: boolean;
      error?: string;
    };
    expect(output.isError).toBe(true);
    expect(output.error).toBe("provider 503");
    expect(output.reply).toBe("");
    // The agent was still torn down on the degrade path.
    expect(closed).toBe(true);

    // Same failure WITHOUT the nonFatal tag propagates (fails the run).
    const fatalReq: StepInvokeRequest = {
      agent: {
        ...makeAgentDefinition("inline-variant"),
        tags: { "workbench.stepKind": "inline-inference" },
      },
      input: { input: "run it" },
      authzContext: { stepId: STEP_ID, attempt: 2, runId: RUN_ID },
      signal: new AbortController().signal,
    };
    await expect(invoke(fatalReq)).rejects.toThrow("provider 503");
  });

  test("a nonFatal step with a retry policy throws until the last attempt, then degrades (so retry actually fires)", async () => {
    const dataDir = await makeDataDir();
    const throwingAgent: Agent = {
      send: async () => {
        throw new Error("provider 503");
      },
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => throwingAgent,
    });

    const agent = {
      ...makeAgentDefinition("inline-variant"),
      tags: {
        "workbench.stepKind": "inline-inference",
        "workbench.nonFatal": "true",
        "workbench.inlineRetryMaxAttempts": "3",
      },
    };

    // Attempts 1 and 2 THROW — the engine's RetryPolicy re-invokes (this is what
    // makes retry fire at all for a non-fatal step).
    for (const attempt of [1, 2]) {
      await expect(
        invoke({
          agent,
          input: { input: "run it" },
          authzContext: { stepId: STEP_ID, attempt, runId: RUN_ID },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("provider 503");
    }

    // The final attempt degrades to the non-fatal isError skip.
    const last = await invoke({
      agent,
      input: { input: "run it" },
      authzContext: { stepId: STEP_ID, attempt: 3, runId: RUN_ID },
      signal: new AbortController().signal,
    });
    expect((last.output as { isError?: boolean }).isError).toBe(true);
  });

  test("a nonFatal inline step still rethrows on cancellation (never masks a run cancel)", async () => {
    const dataDir = await makeDataDir();
    const controller = new AbortController();
    const throwingAgent: Agent = {
      send: async () => {
        controller.abort();
        throw new Error("aborted mid-turn");
      },
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => throwingAgent,
    });

    const req: StepInvokeRequest = {
      agent: {
        ...makeAgentDefinition("inline-variant"),
        tags: {
          "workbench.stepKind": "inline-inference",
          "workbench.nonFatal": "true",
        },
      },
      input: { input: "run it" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: controller.signal,
    };
    // Signal aborted during the turn → the throw is the cancellation, not a
    // variant failure, so it must propagate even with nonFatal set.
    await expect(invoke(req)).rejects.toThrow("aborted mid-turn");
  });

  // CL-2253: the inline branch must attach a draining stream() consumer so the
  // agent's pre-start event buffer drains instead of overflowing (the WARN
  // "no stream() consumer ever attached to drain it" on staging) and the step's
  // live progress events are observable. This stub emits events through stream()
  // and blocks the iterator open until close() fires; the assertion is that the
  // inline branch consumed every emitted event AND returned the correct reply.
  // Under the pre-CL-2253 no-drain code stream() is never called, so
  // consumedEvents stays empty and this test fails.
  test("inline-inference branch drains the agent event stream", async () => {
    const dataDir = await makeDataDir();
    const INLINE_REPLY = '{"painPoints":[]}';
    const turn = {
      role: "assistant",
      content: INLINE_REPLY,
    } as unknown as SendTurn;
    const emitted = [
      { type: "reactor.start" },
      { type: "inference.done" },
    ] as const;

    const consumedEvents: unknown[] = [];
    let streamInvoked = false;
    let closed = false;
    // Gate the iterator's terminal `done` on close() so the test proves the
    // consumer drains concurrently with send() and exits cleanly on teardown
    // (a leaked, never-closing iterator would hang the invoker).
    let resolveDone: (() => void) | undefined;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const stubAgent: Agent = {
      send: async (content: Parameters<Agent["send"]>[0]) => {
        void content;
        return { reply: INLINE_REPLY, turn };
      },
      stream: () => {
        streamInvoked = true;
        let index = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (index < emitted.length) {
                const value = emitted[index];
                index += 1;
                return { value, done: false };
              }
              await donePromise;
              return { value: undefined, done: true };
            },
          }),
        };
      },
      deliver: () => {},
      close: async () => {
        closed = true;
        resolveDone?.();
      },
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    // Wrap stream() so the test observes exactly which events the inline branch
    // pulled off the iterator.
    const realStream = stubAgent.stream.bind(stubAgent);
    stubAgent.stream = () => {
      const it = realStream()[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const r = await it.next();
            if (!r.done) consumedEvents.push(r.value);
            return r;
          },
        }),
      };
    };

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => stubAgent,
    });

    const inlineAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition("inline-analyze"),
      tags: { "workbench.stepKind": "inline-inference" },
    };
    const req: StepInvokeRequest = {
      agent: inlineAgent,
      input: { transcript: "they hate slow onboarding" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    const result = await invoke(req);

    // Reply is unchanged by the drain.
    expect(result.output).toEqual({ reply: INLINE_REPLY, turn });
    // A draining consumer was attached and pulled every emitted event.
    expect(streamInvoked).toBe(true);
    expect(consumedEvents).toEqual([...emitted]);
    // The agent was torn down (which is what releases the iterator).
    expect(closed).toBe(true);
  });
});

describe("createStepToolContextResolver", () => {
  // Stub RepoStore whose `getRepoDir` points the grants read at an empty
  // temp dir; the resolver's `readStepGrants` ENOENTs and falls back to
  // deny-all, isolating the assertion to the derived step agent id.
  function makeStubBareStore(dir: string): RepoStore {
    return {
      getRepoDir: () => dir,
    } as unknown as RepoStore;
  }

  function makeReq(stepId: string): StepInvokeRequest {
    return {
      agent: makeAgentDefinition("step-agent"),
      input: {},
      authzContext: { stepId, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };
  }

  test("derives stepAgentId as ins_<rawDeploymentId>-<stepId>, byte-for-byte", async () => {
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      dataDir,
      mailboxAddress: "ins_dep@tenant.example",
      stepCount: 2,
      // RAW hub deploymentId (`ses_<id>`), the value the deploy router
      // threads via WORKFLOW_RAW_DEPLOYMENT_ID.
      deploymentId: "ses_218f6ab782774a3e70b5d86f01e602d8",
      tenantId: "ten_1",
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      // Single-agent identity is ignored on the multi-step (stepCount > 1)
      // branch these tests exercise; supplied to satisfy the required args.
      singleAgentId: "agt_ignored",
      singleAgentPrincipalId: "prn_ignored",
      cacheRoot: path.join(dataDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq("intake"));

    const expected = "ins_ses_218f6ab782774a3e70b5d86f01e602d8-intake";
    expect(ctx.stepAgentId).toBe(expected);
    expect(ctx.stepAddress).toBe(expected);
    expect(ctx.principalId).toBe(expected);
    // The bug shapes this fix closes: no double ins_, no slugified
    // deployment address.
    expect(ctx.stepAgentId).not.toContain("ins_ins_");
    expect(ctx.stepAgentId).not.toContain("abklabs-com");
    // Missing grants file -> fail-closed deny-all.
    expect(ctx.grants).toEqual([]);
  });

  test("normalizes a map-expanded stepId to its base for the step agent id", async () => {
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      dataDir,
      mailboxAddress: "ins_dep@tenant.example",
      stepCount: 2,
      deploymentId: "ses_218f6ab782774a3e70b5d86f01e602d8",
      tenantId: "ten_1",
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      // Single-agent identity is ignored on the multi-step (stepCount > 1)
      // branch these tests exercise; supplied to satisfy the required args.
      singleAgentId: "agt_ignored",
      singleAgentPrincipalId: "prn_ignored",
      cacheRoot: path.join(dataDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    // `map` fans `persist` into `persist[0]`; the hub only registered the step
    // agent row + grants + tool manifest under `persist`, so the resolver must
    // strip the `[i]` suffix or the mapped step's tools never load.
    const ctx = await resolve(makeReq("persist[0]"));
    expect(ctx.stepAgentId).toBe(
      "ins_ses_218f6ab782774a3e70b5d86f01e602d8-persist",
    );
  });

  test("a slug-shaped deploymentId would NOT have produced the registered id (documents the regression)", async () => {
    const dataDir = await makeDataDir();
    // Feeding the slugified deployment address (the pre-fix bug) yields
    // the double-prefixed, dot-slugged id the hub never registered.
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      dataDir,
      mailboxAddress: "ins_dep@tenant.example",
      stepCount: 2,
      deploymentId: "ins_ses_abc-abklabs-com",
      tenantId: "ten_1",
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      // Single-agent identity is ignored on the multi-step (stepCount > 1)
      // branch these tests exercise; supplied to satisfy the required args.
      singleAgentId: "agt_ignored",
      singleAgentPrincipalId: "prn_ignored",
      cacheRoot: path.join(dataDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq("intake"));

    expect(ctx.stepAgentId).toBe("ins_ins_ses_abc-abklabs-com-intake");
    expect(ctx.stepAgentId).not.toBe("ins_ses_abc-intake");
  });

  // A recording bare store: captures every `getRepoDir(repoId)` and points the
  // grants read at a single on-disk dir where the test stages `state/grants.json`.
  function makeRecordingBareStore(dir: string): {
    store: RepoStore;
    calls: RepoId[];
  } {
    const calls: RepoId[] = [];
    const store = {
      getRepoDir: (repoId: RepoId) => {
        calls.push(repoId);
        return dir;
      },
    } as unknown as RepoStore;
    return { store, calls };
  }

  test("single-agent (stepCount === 1) keys the credential + hub-backed rails on the REAL agent id + instance principal and reads the LEGACY grants repo, not ins_<raw>-default", async () => {
    // A single launched agent (Myra/Oat) is deployed via `deployInstanceAtHead`:
    // NO `ins_<raw>-<step>` hub row, and its grants live in the legacy
    // agent-state repo keyed by the instance id (`parseAgentId(address)`). The
    // pre-fix resolver derived `ins_<raw>-default` for both the credential
    // agentId and the grants repo, matching NOTHING the hub wrote — tool
    // credentials 404, hub-backed tools 403, grants deny-all.
    const grantsDir = await makeDataDir();
    // Stage a real granted native tool in the LEGACY repo working tree.
    await fs.mkdir(path.join(grantsDir, "state"), { recursive: true });
    const grantRule = {
      id: "gr_1",
      resource: "tool:granola_list_documents",
      action: "invoke",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
    };
    await fs.writeFile(
      path.join(grantsDir, "state", "grants.json"),
      JSON.stringify({ grants: [grantRule] }),
    );

    const { store, calls } = makeRecordingBareStore(grantsDir);
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: store,
      dataDir,
      // The deployment's REAL (legacy) mail address; its instance id is the
      // legacy agent-state repo key.
      mailboxAddress: "ins_hex7f@abklabs.com",
      stepCount: 1,
      // RAW hub deploymentId (`deriveRawDeploymentId(ins_hex7f)` === `hex7f`).
      // The pre-fix resolver would have keyed everything off this.
      deploymentId: "hex7f",
      tenantId: "ten_1",
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      // The identity the hub actually has for the single agent.
      singleAgentId: "agt_myra",
      singleAgentPrincipalId: "prn_instance_1",
      cacheRoot: path.join(dataDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq("default"));

    // Credential rail (`agentId`) + hub-backed rail (`agentId` + `principalId`)
    // use the identity the hub wrote, NOT the synthetic step id.
    expect(ctx.stepAgentId).toBe("agt_myra");
    expect(ctx.principalId).toBe("prn_instance_1");
    expect(ctx.stepAgentId).not.toBe("ins_hex7f-default");
    expect(ctx.principalId).not.toBe("ins_hex7f-default");

    // Grants were read from the LEGACY agent-state repo keyed by the instance
    // id — the same repo `writeStepGrants` + the single-agent `deriveStepRepoId`
    // wrote them to — NOT `hex7f-default`.
    expect(calls).toContainEqual({ kind: "agent-state", id: "ins_hex7f" });
    for (const call of calls) {
      expect(call.id).not.toBe("hex7f-default");
    }

    // The granted native tool resolves as ALLOW (authorized, not deny-all).
    expect(ctx.grants).toHaveLength(1);
    const decision = await evaluateGrants(
      ctx.grants,
      "tool:granola_list_documents",
      "invoke",
    );
    expect(decision.effect).toBe("allow");
  });

  test("a single-STEP workflow (stepCount === 1, agentId === instance id) keeps the derived ins_<raw>-<step> step identity, NOT the empty supervisor identity", async () => {
    // A single-step workflow definition (`stepOrder.length === 1`) is NOT a
    // launched agent: it deploys via `deploySingleStepAtHead`, whose frame
    // `agentId` is `deriveDeploymentAgentId(deploymentId)` === the mailbox
    // address's instance id (`ins_dep`), backed by the EMPTY supervisor `agent`
    // row (`writeDeploymentAgentRow`: toolPackages [], capabilities null). Its
    // REAL step tools + grants live at `ins_<raw>-<stepId>` / `<raw>-<stepId>`
    // (`writeStepAgentRows` / `writeStepGrantFiles`). Gating the single-agent
    // branch on raw `stepCount === 1` (the pre-fix bug) keyed the credential +
    // hub-backed rails on the supervisor identity — 0 tool packages, deny-all
    // grants. Provenance (`singleAgentId === instanceId`) routes it to the
    // step-identity else branch instead.
    const grantsDir = await makeDataDir();
    await fs.mkdir(path.join(grantsDir, "state"), { recursive: true });
    const grantRule = {
      id: "gr_step",
      resource: "tool:granola_list_documents",
      action: "invoke",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
    };
    await fs.writeFile(
      path.join(grantsDir, "state", "grants.json"),
      JSON.stringify({ grants: [grantRule] }),
    );

    const { store, calls } = makeRecordingBareStore(grantsDir);
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: store,
      dataDir,
      mailboxAddress: "ins_dep@abklabs.com",
      // A one-step workflow: physically head-collapsed on disk, so stepCount is 1.
      stepCount: 1,
      // RAW hub deploymentId (`deriveRawDeploymentId(ins_dep)` === `dep`).
      deploymentId: "dep",
      tenantId: "ten_1",
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      // The single-step workflow frame's agentId is the SUPERVISOR id, equal to
      // the mailbox instance id — the signal that this is NOT a launched agent.
      singleAgentId: "ins_dep",
      singleAgentPrincipalId: "ins_dep",
      cacheRoot: path.join(dataDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq("compare"));

    // Identity is the hub-written step identity, NOT the empty supervisor id.
    expect(ctx.stepAgentId).toBe("ins_dep-compare");
    expect(ctx.principalId).toBe("ins_dep-compare");
    expect(ctx.stepAgentId).not.toBe("ins_dep");
    expect(ctx.principalId).not.toBe("ins_dep");

    // Grants read from the per-step repo `<raw>-<stepId>`, NOT the supervisor's
    // legacy `ins_dep` agent-state repo.
    expect(calls).toContainEqual({ kind: "agent-state", id: "dep-compare" });
    for (const call of calls) {
      expect(call.id).not.toBe("ins_dep");
    }

    // The granted step tool resolves ALLOW: its grants were actually read.
    expect(ctx.grants).toHaveLength(1);
    const decision = await evaluateGrants(
      ctx.grants,
      "tool:granola_list_documents",
      "invoke",
    );
    expect(decision.effect).toBe("allow");
  });
});

// A stub agent whose send() count + last-content are observable, used to
// prove the warm cache reuses ONE built agent across messages.
function makeCountingAgent(log: { sends: string[]; closed: boolean }): Agent {
  return {
    send: async (content: Parameters<Agent["send"]>[0]) => {
      const text =
        typeof content === "string" ? content : (content.content ?? "");
      log.sends.push(text);
      return {
        reply: `reply-${log.sends.length}`,
        turn: {
          role: "assistant",
          content: `reply-${log.sends.length}`,
        } as unknown as SendTurn,
      };
    },
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true }),
      }),
    }),
    deliver: () => {},
    close: async () => {
      log.closed = true;
    },
    setSource: () => {},
    setSources: () => {},
  } as unknown as Agent;
}

describe("warm-keep single-step durability", () => {
  test("reuses one built agent across two messages and fires the run-boundary mirror per message", async () => {
    const dataDir = await makeDataDir();
    let buildCount = 0;
    const agentLog = { sends: [] as string[], closed: false };
    const agent = makeCountingAgent(agentLog);

    const warmCache = createWarmAgentCache();
    const mirroredKeys: string[] = [];

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      warmCache,
      onRunBoundary: async (key: string) => {
        mirroredKeys.push(key);
      },
      agentFactory: async () => {
        buildCount += 1;
        return agent;
      },
    });

    const first = await invoke(makeRequest());
    const second = await invoke(makeRequest());

    // ONE build across two messages: the warm cache reused the cached agent
    // rather than instantiate-send-teardown per message.
    expect(buildCount).toBe(1);
    expect(agentLog.sends).toHaveLength(2);
    // The agent was NOT closed between messages (warm agents span messages).
    expect(agentLog.closed).toBe(false);
    expect(first.output).toEqual({
      reply: "reply-1",
      turn: { role: "assistant", content: "reply-1" } as unknown as SendTurn,
    });
    expect(second.output).toEqual({
      reply: "reply-2",
      turn: { role: "assistant", content: "reply-2" } as unknown as SendTurn,
    });
    // The run-boundary durability flush fired once per message, keyed by the
    // step id (the warm cache key).
    expect(mirroredKeys).toEqual([STEP_ID, STEP_ID]);
  });

  test("cold path (no warmCache) rebuilds and tears down the agent per message", async () => {
    const dataDir = await makeDataDir();
    let buildCount = 0;
    let closeCount = 0;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        buildCount += 1;
        const log = { sends: [] as string[], closed: false };
        const agent = makeCountingAgent(log);
        return {
          ...agent,
          send: agent.send.bind(agent),
          close: async () => {
            closeCount += 1;
          },
        } as unknown as Agent;
      },
    });

    await invoke(makeRequest());
    await invoke(makeRequest());

    expect(buildCount).toBe(2);
    expect(closeCount).toBe(2);
  });
});

describe("supervisor-backed outbound transport wiring", () => {
  test("the step env carries a transport whose send routes to the outbound bridge", async () => {
    const dataDir = await makeDataDir();
    const submitted: { sender: string; message: OutboundMessage }[] = [];
    const bridge: ChildOutboundMailBridge = {
      submit: async (
        sender: string,
        message: OutboundMessage,
      ): Promise<SendReceipt> => {
        submitted.push({ sender, message });
        return { messageId: "mid-1", status: "delivered" };
      },
      handleResult: () => {},
      cancelAll: () => {},
      pendingCount: 0,
    };

    let capturedEnv:
      | (BaseEnv & { transport?: unknown; address?: unknown })
      | undefined;
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      outboundMailBridge: bridge,
      mailboxAddress: "ins_ses_warm@example.com",
      agentFactory: async (_def, env) => {
        capturedEnv = env as BaseEnv & {
          transport?: unknown;
          address?: unknown;
        };
        return stubAgent;
      },
    });

    await invoke(makeRequest());

    expect(capturedEnv).toBeDefined();
    const env = capturedEnv as BaseEnv & {
      transport: { send: (m: OutboundMessage) => Promise<SendReceipt> };
      address: string;
    };
    expect(env.address).toBe("ins_ses_warm@example.com");
    // The transport's send routes through the bridge to the supervisor for
    // the actual signed send (the step agent never holds the key). A missing
    // bridge would leave env.transport undefined and a mail tool's send()
    // would throw, not hang.
    const outbound: OutboundMessage = {
      to: "someone@example.com",
      subject: "s",
      type: "conversation.message" as unknown as OutboundMessage["type"],
      content: "b",
    };
    const receipt = await env.transport.send(outbound);
    expect(receipt).toEqual({ messageId: "mid-1", status: "delivered" });
    expect(submitted).toEqual([
      { sender: "ins_ses_warm@example.com", message: outbound },
    ]);
  });

  test("no transport is wired when the outbound bridge is absent", async () => {
    const dataDir = await makeDataDir();
    let capturedEnv: (BaseEnv & { transport?: unknown }) | undefined;
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
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async (_def, env) => {
        capturedEnv = env as BaseEnv & { transport?: unknown };
        return stubAgent;
      },
    });

    await invoke(makeRequest());
    expect(capturedEnv).toBeDefined();
    expect(
      (capturedEnv as BaseEnv & { transport?: unknown }).transport,
    ).toBeUndefined();
  });
});

// C3 (greybeard review of #364): the durable-conversation store is NOT inert
// today. For EVERY single-step deploy (warmKeep === stepOrder.length === 1 —
// true for single-step DETERMINISTIC and INLINE-INFERENCE workflows, not only
// future warm reasoning agents) `createSidecarSubstrateFactory` builds a real
// `durableConversation` registry and the per-step env build runs
// `acquire(stepId)` -> `restoreFromSubstrate()` on the live path. It is a clean
// no-op on a first-ever run (restore returns false; the only writer is the warm
// inference send path the deterministic/inline branches never reach), but that
// exact production combination — a real durable registry wired into a
// non-inference dispatch — was untested. This exercises it end-to-end against a
// real registry + on-disk substrate and asserts startup neither throws nor
// blocks: acquire runs, restoreFromSubstrate returns false, the warm store
// backs the env (warm keying, not the per-run isogit store), and the
// deterministic tool actually runs.
function createOnDiskSubstrate(repoDir: string): RepoStore {
  async function readDirectChildren(
    prefixAbs: string,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    let entries: string[];
    try {
      entries = await fs.readdir(prefixAbs);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(prefixAbs, entry);
      const stat = await fs.stat(full);
      if (stat.isFile()) {
        const rel = path.relative(repoDir, full).split(path.sep).join("/");
        out.set(rel, await fs.readFile(full));
      }
    }
    return out;
  }

  const stub: Partial<RepoStore> = {
    getRepoDir(_repoId: RepoId): string {
      return repoDir;
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      const prefixAbs = path.join(repoDir, args.preservePrefix);
      const existing = await readDirectChildren(prefixAbs);
      const merged = await args.merge(existing);
      await fs.rm(prefixAbs, { recursive: true, force: true });
      for (const [rel, bytes] of Object.entries(merged)) {
        const dest = path.join(repoDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(bytes));
      }
      return { commitSha: "on-disk-sha", newlyTerminalRuns: [] };
    },
  };

  return new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(`test substrate: ${String(prop)} not implemented`);
      };
    },
  });
}

describe("live durable-conversation seam on a single-step (warmKeep) deploy", () => {
  test("a deterministic dispatch runs acquire + restoreFromSubstrate (returning false) cleanly without throwing or blocking startup", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const repoDir = await makeDataDir();
    const repoId: RepoId = { kind: "workflow-run", id: "wfr-warm-c3" };
    const principal: Principal = {
      kind: "workflow-process",
      deploymentId: "ses_warm_c3",
    } as unknown as Principal;

    const substrate = createOnDiskSubstrate(repoDir);

    // Half 1 — the no-op-clean contract, observed directly: a freshly-built
    // durable store over a substrate with no prior snapshot returns false from
    // restoreFromSubstrate and neither throws nor hangs. This is exactly what
    // the registry runs inside acquire(); asserting the boolean here proves the
    // first-ever-run path the deterministic/inline branches hit is a clean
    // no-op, not a silent failure.
    const probeStore: DurableConversationStore =
      await createDurableConversationStore({
        localStoreDir: path.join(dataDir, "probe-store"),
        signer: async () => "sig",
        substrate,
        workflowRunRepoId: repoId,
        workflowRunRef: "refs/heads/main",
        principal,
        agentKey: STEP_ID,
      });
    const probeRestore = await probeStore.restoreFromSubstrate();
    expect(probeRestore).toBe(false);

    // The exact production object: the real registry the factory builds when
    // env.spawn.warmKeep is true, backed by the same real on-disk substrate.
    const realRegistry = createDurableConversationRegistry({
      dataDir,
      workflowRunRepoId: repoId,
      workflowRunRef: "refs/heads/main",
      substrate,
      principal,
      signer: async () => "sig",
    });

    // Spy only on acquire so we confirm the LIVE buildEnv path fires the seam
    // (acquire runs restoreFromSubstrate internally). We do NOT stub anything —
    // acquire and its internal restore run for real against the substrate.
    let acquireKey: string | undefined;
    let acquireCount = 0;
    const registry: DurableConversationRegistry = {
      get: (key) => realRegistry.get(key),
      acquire: async (key) => {
        acquireKey = key;
        acquireCount += 1;
        return realRegistry.acquire(key);
      },
    };

    let factoryCalled = false;
    let capturedStorage: unknown;
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
        // No deploy/ subtree under dataDir → empty on-disk manifest.
        deployTreeDir: dataDir,
        cacheRoot: path.join(dataDir, "cache"),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      };
    };

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: [SOURCE] },
      dataDir,
      workflowRunRepoId: repoId,
      signer: async () => "sig",
      directors: createDefaultDirectorRegistry(),
      adapters: createBuiltinRegistry(),
      evaluateGrants: allowAll,
      resolveStepToolContext,
      // Wiring a real durableConversation is what selects the warm-path env
      // keying and triggers the acquire/restore seam in buildEnv.
      durableConversation: registry,
      agentFactory: async (_def, env) => {
        // The deterministic branch must NOT reach the inference factory; if it
        // ever does, capture the storage to prove the durable store backed it.
        factoryCalled = true;
        capturedStorage = (env as unknown as Record<string, unknown>).storage;
        throw new Error(
          "inference factory must not run for a deterministic step",
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

    const result = await invoke({
      agent: detAgent,
      input: { path: "c3.txt", content: "durable-seam-ok" },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    });

    // Startup did not block or throw: the deterministic tool ran to completion.
    const output = result.output as Record<string, unknown>;
    expect(output).toHaveProperty("callId");
    expect(output.isError).not.toBe(true);
    // The durable seam fired on the live path: buildEnv acquired the store
    // (which runs restoreFromSubstrate internally) keyed by the stepId, exactly
    // once, for this non-inference dispatch.
    expect(acquireKey).toBe(STEP_ID);
    expect(acquireCount).toBe(1);
    // The deterministic branch never reached the inference agent factory.
    expect(factoryCalled).toBe(false);
    expect(capturedStorage).toBeUndefined();
    // The live acquire materialized the durable per-agent store on disk under
    // the conversation-state root keyed by the stepId — proof the warm/durable
    // env path (not the cold per-run isogit store) backed this dispatch. This
    // root survives the deterministic step's per-call scratch cleanup, so a
    // re-deploy would resume from it.
    const durableRoot = path.join(
      dataDir,
      "agent-conversation-state",
      repoId.id,
      STEP_ID,
    );
    expect((await fs.stat(durableRoot)).isDirectory()).toBe(true);
    // The warm keying was used, NOT the cold per-run layout: the per-run
    // `runs/<runId>/` subtree was never created (the deterministic step keyed
    // its scratch under the stable `warm/<stepId>/` sub-root and reclaimed it
    // on completion, leaving no per-run tree behind).
    const runRoot = path.join(
      dataDir,
      "workflow-step-state",
      repoId.id,
      "runs",
      RUN_ID,
    );
    await expect(fs.stat(runRoot)).rejects.toThrow();
  });
});

// The child-side deserialization boundary for the operator adapter manifest:
// the supervisor threads the boot edge's validated manifest through
// `substrateEnv` as JSON, and the child must reject a corrupted wire value
// loudly before `loadAdapterRegistry` would import() anything off it.
describe("parseAdapterManifest", () => {
  test("parses a valid manifest", () => {
    const manifest = [
      { provider: "acme", specifier: "@acme/adapter", export: "createAdapter" },
    ];
    expect(parseAdapterManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  test("parses the empty manifest (the no-custom-adapters default)", () => {
    expect(parseAdapterManifest("[]")).toEqual([]);
  });

  test("throws loudly on malformed JSON", () => {
    expect(() => parseAdapterManifest("{not json")).toThrow(
      "sidecar workflow-child substrate config: SIDECAR_ADAPTER_MANIFEST is not valid JSON",
    );
  });

  test("throws with the validation summary on a schema-violating entry", () => {
    const invalid = JSON.stringify([{ provider: "acme" }]);
    expect(() => parseAdapterManifest(invalid)).toThrow(
      /SIDECAR_ADAPTER_MANIFEST failed validation:.*specifier/s,
    );
  });

  test("throws on a non-array root", () => {
    expect(() => parseAdapterManifest('{"provider":"x"}')).toThrow(
      "SIDECAR_ADAPTER_MANIFEST failed validation",
    );
  });
});
