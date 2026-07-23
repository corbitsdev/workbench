// Guards the upstream-adopted cold-path step-storage restructure (CL-2335):
// per-step scratch is rooted at
// `workflow-step-state/<repoId>/runs/<runId>/steps/<stepId>/attempt-<N>/`,
// each run gets its own subtree, and `runStepStorageRoot` nests every
// step/attempt of a run so a single reclaim drops the whole run. Also guards
// `parseByteCap`'s positive-finite contract.

import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RepoId } from "@workbench/hub-sessions";
import { createDefaultDirectorRegistry } from "@intx/agent";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type { Agent, AgentDefinition, BaseEnv } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import type { GrantEvaluator } from "@workbench/workflow-host";
import type { StepInvokeRequest } from "@intx/workflow";

import {
  parseByteCap,
  stepStorageRoot,
  runStepStorageRoot,
  createSidecarStepInvoker,
} from "./workflow-substrate-factory";

type SendTurn = Extract<
  Awaited<ReturnType<Agent["send"]>>,
  { type: "reply" }
>["turn"];

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-step-storage-"));
  tmpDirs.push(dir);
  return dir;
}

const REPO_ID: RepoId = { kind: "workflow-run", id: "wfr-deploy-1" };
const STEP_ID = "draft";
const SOURCE: InferenceSource = {
  id: "src-1",
  provider: "openai-compatible",
  baseURL: "https://example.invalid",
  apiKey: "sk-test",
  model: "test-model",
};

describe("parseByteCap", () => {
  test("accepts a positive finite numeric string", () => {
    expect(parseByteCap("1024", "SIDECAR_CACHE_MAX_BYTES")).toBe(1024);
    expect(parseByteCap("67108864", "SIDECAR_REGISTRY_MAX_TARBALL_BYTES")).toBe(
      67108864,
    );
  });

  test("rejects zero, negative, NaN, and non-finite inputs", () => {
    expect(() => parseByteCap("0", "CAP")).toThrow(/positive finite number/);
    expect(() => parseByteCap("-5", "CAP")).toThrow(/positive finite number/);
    expect(() => parseByteCap("abc", "CAP")).toThrow(/positive finite number/);
    expect(() => parseByteCap("Infinity", "CAP")).toThrow(
      /positive finite number/,
    );
    expect(() => parseByteCap("", "CAP")).toThrow(/positive finite number/);
  });

  test("names the offending key in the error", () => {
    expect(() => parseByteCap("nope", "SIDECAR_CACHE_MAX_BYTES")).toThrow(
      /SIDECAR_CACHE_MAX_BYTES/,
    );
  });
});

describe("stepStorageRoot / runStepStorageRoot", () => {
  test("cold path is workflow-step-state/<repoId>/runs/<runId>/steps/<stepId>/attempt-<N>", () => {
    const root = stepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-1",
      stepId: "intake",
      attempt: 2,
    });
    expect(root).toBe(
      path.join(
        "/data",
        "workflow-step-state",
        "wfr-deploy-1",
        "runs",
        "run-1",
        "steps",
        "intake",
        "attempt-2",
      ),
    );
  });

  test("runStepStorageRoot is the run subtree the cold step path nests under", () => {
    const runRoot = runStepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-1",
    });
    const stepRoot = stepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-1",
      stepId: "intake",
      attempt: 1,
    });
    expect(runRoot).toBe(
      path.join(
        "/data",
        "workflow-step-state",
        "wfr-deploy-1",
        "runs",
        "run-1",
      ),
    );
    // The step root is contained under the run root, so one reclaim drops all.
    expect(stepRoot.startsWith(`${runRoot}${path.sep}`)).toBe(true);
  });

  test("two runs of the same step occupy disjoint subtrees", () => {
    const a = stepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-A",
      stepId: STEP_ID,
      attempt: 1,
    });
    const b = stepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-B",
      stepId: STEP_ID,
      attempt: 1,
    });
    expect(a).not.toBe(b);
    expect(
      a.startsWith(
        runStepStorageRoot({
          dataDir: "/data",
          workflowRunRepoId: REPO_ID,
          runId: "run-B",
        }),
      ),
    ).toBe(false);
  });

  test("a separator-bearing id cannot escape the run subtree", () => {
    const runRoot = runStepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-1",
    });
    const root = stepStorageRoot({
      dataDir: "/data",
      workflowRunRepoId: REPO_ID,
      runId: "run-1",
      stepId: "../escape",
      attempt: 1,
    });
    // The `/` in the malicious id is sanitized to `_`, so the path stays a
    // single segment under the run's `steps/` dir and never traverses out.
    expect(root.startsWith(path.join(runRoot, "steps") + path.sep)).toBe(true);
    expect(path.relative(runRoot, root).startsWith("..")).toBe(false);
  });
});

const allowAll: GrantEvaluator = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

function makeAgentDefinition(id: string): AgentDefinition<BaseEnv> {
  return {
    id,
    systemPrompt: "test agent",
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
  };
}

function makeStubAgent(): Agent {
  return {
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
}

describe("createSidecarStepInvoker workspace placement (cold path)", () => {
  test("roots the per-step workspace under the new workflow-step-state layout and never leaks across runs", async () => {
    const dataDir = await makeDataDir();

    async function run(runId: string): Promise<string> {
      let workdir = "";
      const stubInvoke = createSidecarStepInvoker({
        table: { [STEP_ID]: [SOURCE] },
        dataDir,
        workflowRunRepoId: REPO_ID,
        signer: async () => "sig",
        directors: createDefaultDirectorRegistry(),
        adapters: createBuiltinRegistry(),
        evaluateGrants: allowAll,
        agentFactory: async (_def, env) => {
          workdir = env.workdir;
          return makeStubAgent();
        },
      });
      const req: StepInvokeRequest = {
        agent: makeAgentDefinition("a"),
        input: {},
        authzContext: { stepId: STEP_ID, attempt: 1, runId },
        signal: new AbortController().signal,
      };
      await stubInvoke(req);
      return workdir;
    }

    const wdA = await run("run-A");
    const wdB = await run("run-B");

    // Each workspace sits under the new layout, scoped to its own run.
    const expectedA = path.join(
      stepStorageRoot({
        dataDir,
        workflowRunRepoId: REPO_ID,
        runId: "run-A",
        stepId: STEP_ID,
        attempt: 1,
      }),
      "workspace",
    );
    expect(wdA).toBe(expectedA);
    expect(wdA).toContain(
      path.join("workflow-step-state", REPO_ID.id, "runs", "run-A"),
    );
    expect(wdB).toContain(
      path.join("workflow-step-state", REPO_ID.id, "runs", "run-B"),
    );
    // No cross-run leak: run-A's workspace is not under run-B's subtree.
    const runBRoot = runStepStorageRoot({
      dataDir,
      workflowRunRepoId: REPO_ID,
      runId: "run-B",
    });
    expect(wdA.startsWith(runBRoot)).toBe(false);
    // The directories were actually created on disk.
    expect((await fs.stat(wdA)).isDirectory()).toBe(true);
    expect((await fs.stat(wdB)).isDirectory()).toBe(true);
  });
});
