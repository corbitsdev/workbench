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

import type {
  Agent,
  AgentDefinition,
  BaseEnv,
  ConversationTurn,
} from "@intx/agent";
import { createDefaultDirectorRegistry } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import type { GrantEvaluator } from "@intx/workflow-host";
import type { StepInvokeRequest } from "@intx/workflow";

import { createSidecarStepInvoker } from "./workflow-substrate-factory";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

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
    const turn: ConversationTurn = {
      role: "assistant",
      content: REPLY,
    } as unknown as ConversationTurn;

    let sentContent: string | undefined;
    let closed = false;
    const stubAgent: Agent = {
      send: async (content) => {
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
        turn: { role: "assistant", content: "ok" } as unknown as ConversationTurn,
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
});
