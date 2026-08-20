// Runtime-env-level probe for the CL-6325 `invokeAction`/`loopFns` bind.
//
// Exercises the PRODUCTION seam end to end: the sidecar's
// `resolveActionHandler` binding (the workbench-native
// `createActionToolHandlerRegistry` over a fake tool materializer) is
// resolved exactly the way `runWorkflowChild` resolves it, threaded into
// the vendored `buildRuntimeEnv`, and a probe workflow with a native
// `action` step is driven through `runtimeRun` against a real on-disk
// workflow-run substrate. Proven here:
//   - a declared action dispatches its materialized tool and the run
//     completes;
//   - the effect ledger dedups the effect exactly-once (a replayed
//     invocation returns the recorded output without re-running the tool);
//   - an effect whose capability the step's `effect.requires` does NOT
//     declare is refused loudly and fails the run;
//   - a handler ref no action step declares is refused loudly;
//   - `loopFns` and `runLoopIteration` are bound, and an unregistered
//     loop-fn ref is refused loudly (the fail-closed default registry).

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import {
  createDefaultDirectorRegistry,
  defineTool,
  type ToolBundle,
} from "@intx/agent";
import {
  createRepoStore,
  workflowRunKindHandler,
  WORKFLOW_RUN_GITIGNORE_PATH,
} from "@intx/hub-sessions";
import type { AuthorizeFn } from "@intx/hub-sessions";
import type {
  RepoId,
  WorkflowRunWorkflowProcessPrincipal,
} from "@intx/hub-sessions/substrate";
import {
  action,
  defineWorkflow,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
} from "@intx/workflow";
import {
  buildRuntimeEnv,
  createControlChannelSender,
  createWorkflowHostDrainController,
  createWorkflowRunRepoStore,
  generateChannelId,
  type CredentialWiring,
  type RunWorkflowChildBindings,
} from "@intx/workflow-host";
import { createCredentialProviderRegistry } from "@intx/harness";

import {
  createActionToolHandlerRegistry,
  type ActionStepMaterializationArgs,
  type MaterializeStepTools,
} from "../src/action-tool-handler";
import { runtimeRun } from "@intx/workflow";

const REF = "refs/heads/main";
const DEPLOYMENT_ID = "deployment-action-env";
const WORKFLOW_RUN_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: DEPLOYMENT_ID,
};
const allowAll: AuthorizeFn = () => ({ allowed: true });
const PRINCIPAL: WorkflowRunWorkflowProcessPrincipal = {
  kind: "workflow-process",
  anchorRunId: DEPLOYMENT_ID,
};
const workflowAllowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

const tempDirs: string[] = [];
let signingKey: KeyPair;

beforeAll(async () => {
  signingKey = await generateKeyPair();
});

afterAll(async () => {
  for (const d of tempDirs.splice(0)) {
    await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {
      /* best effort */
    });
  }
});

async function makeSubstrate(
  prefix: string,
): Promise<ReturnType<typeof createRepoStore>> {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dataDir);
  const substrate = createRepoStore({
    dataDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  await substrate.writeTree({ kind: "hub" }, WORKFLOW_RUN_REPO_ID, REF, {
    files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
    message: "genesis",
  });
  return substrate;
}

/** One-action probe: dispatches `handler` with a literal input and the
 * given declared effect capabilities. */
function probeDefinition(
  handler: string,
  requires: readonly string[],
): WorkflowDefinition {
  return defineWorkflow({
    id: "wf-action-probe",
    trigger: { type: "manual" },
    steps: {
      act: action({
        handler,
        input: { literal: { text: "ping" } },
        effect: { requires: [...requires] },
      }),
    },
  });
}

const stubCredentialWiring: CredentialWiring = {
  materialRef: { current: null },
  resolveStepGrants: () => [],
};

/** Mirrors the sidecar substrate factory's `resolveActionHandler`
 * binding, with the registry's `materialize` test seam standing in for
 * the on-disk deploy-tree read. */
function makeResolveActionHandler(
  materialize: MaterializeStepTools,
): NonNullable<RunWorkflowChildBindings["resolveActionHandler"]> {
  return ({ definition, credentialWiring }) => {
    const materializationByStepId = new Map<
      string,
      ActionStepMaterializationArgs
    >();
    for (const [stepId, primitive] of Object.entries(definition.steps)) {
      if (primitive.kind !== "action") continue;
      materializationByStepId.set(stepId, {
        dataDir: "/tmp/action-runtime-env-test",
        mailboxAddress: `${DEPLOYMENT_ID}@run.test`,
        stepId,
        stepCount: 1,
        storeDir: "/tmp/action-runtime-env-test/store",
        cache: { cacheMaxBytes: 1024, registryMaxTarballBytes: 1024 },
        registries: new Map(),
        credentials: { wiring: credentialWiring },
      });
    }
    return createActionToolHandlerRegistry({
      definition,
      materializationByStepId,
      providers: createCredentialProviderRegistry([]),
      materialize,
    });
  };
}

async function makeEnvForRun(opts: {
  runId: string;
  definition: WorkflowDefinition;
  materialize: MaterializeStepTools;
}) {
  const substrate = await makeSubstrate("action-runtime-env-");
  const bindings: RunWorkflowChildBindings = {
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    principal: PRINCIPAL,
    invokeStep: async () => ({ output: null }),
    scheduler: { scheduleIn: () => () => undefined },
    evaluateGrants: async () => ({
      effect: "allow" as const,
      matchingGrants: [],
      resolvedBy: null,
    }),
    resolveActionHandler: makeResolveActionHandler(opts.materialize),
  };
  const runtimeRepoStore = createWorkflowRunRepoStore({
    substrate,
    repoId: WORKFLOW_RUN_REPO_ID,
    principal: PRINCIPAL,
    ref: REF,
  });
  // Resolved exactly as `runWorkflowChild` resolves it: awaited once,
  // against the definition and the live credential wiring.
  const resolveActionHandler =
    bindings.resolveActionHandler !== undefined
      ? await bindings.resolveActionHandler({
          definition: opts.definition,
          credentialWiring: stubCredentialWiring,
        })
      : (): never => {
          throw new Error("unreachable: binding wired above");
        };
  const upstreamSender = createControlChannelSender({
    privateKeySeed: signingKey.privateKey,
    channelId: generateChannelId(),
    writer: { write: () => undefined },
  });
  return buildRuntimeEnv({
    runId: opts.runId,
    bindings,
    runtimeRepoStore,
    authorize: workflowAllowAll,
    directors: createDefaultDirectorRegistry(),
    suspendableChildHost: undefined,
    spawnChild: async () => {
      throw new Error("probe workflow spawns no children");
    },
    clock: () => new Date(),
    newId: (prefix: string) => `${prefix}-${String(nextId())}`,
    drainController: createWorkflowHostDrainController({
      definition: opts.definition,
    }),
    warmCache: undefined,
    sourcesRef: { current: {} },
    credentialWiring: stubCredentialWiring,
    onEvent: () => undefined,
    upstreamSender,
    resolveActionHandler,
    loopFns: (ref: string) => {
      throw new Error(`unknown loop fn ${JSON.stringify(ref)}`);
    },
  });
}

let idCounter = 0;
function nextId(): number {
  idCounter += 1;
  return idCounter;
}

/** A one-tool factory that echoes its call arguments back as JSON,
 * counting invocations so exactly-once is observable. */
function countingEchoFactory(toolName: string, counter: { runs: number }) {
  return defineTool({
    id: "@test/echo-tools/echo",
    definitions: [{ name: toolName }],
    factory: (): ToolBundle => ({
      definitions: [{ name: toolName, description: "echo", inputSchema: {} }],
      run: async (call) => {
        counter.runs += 1;
        return {
          callId: call.id,
          content: JSON.stringify(call.arguments),
        };
      },
    }),
  });
}

describe("sidecar runtime-env action bind (CL-6325)", () => {
  test("a declared action dispatches its tool, completes the run, and ledgers exactly once", async () => {
    const counter = { runs: 0 };
    const materialize: MaterializeStepTools = async () => ({
      factories: [countingEchoFactory("probe_echo", counter)],
      pluginFactories: [],
    });
    const definition = probeDefinition("probe_echo", ["probe_echo"]);
    const env = await makeEnvForRun({
      runId: "run-ok",
      definition,
      materialize,
    });

    const handle = runtimeRun(definition, env, { runId: "run-ok" });
    const result = await handle.complete;
    expect(result.terminalStatus).toBe("completed");
    expect(result.outputs["act"]).toBe(JSON.stringify({ text: "ping" }));
    expect(counter.runs).toBe(1);

    // Exactly-once: replaying the same effect against the same run's
    // ledger returns the recorded output without re-running the tool.
    const invokeAction = env.invokeAction;
    if (invokeAction === undefined) {
      throw new Error("runtime env did not bind invokeAction");
    }
    const replayed = await invokeAction({
      handler: "probe_echo",
      input: { text: "ping" },
      requires: ["probe_echo"],
      authzContext: { runId: "run-ok", stepId: "act", attempt: 1 },
      signal: new AbortController().signal,
    });
    expect(replayed.output).toBe(JSON.stringify({ text: "ping" }));
    expect(counter.runs).toBe(1);
  });

  test("an effect capability the step did not declare is refused and fails the run", async () => {
    const counter = { runs: 0 };
    const materialize: MaterializeStepTools = async () => ({
      factories: [countingEchoFactory("probe_echo", counter)],
      pluginFactories: [],
    });
    // The handler dispatches `probe_echo`, but the step declares no
    // effect capabilities -- the EffectContext must refuse the perform.
    const definition = probeDefinition("probe_echo", []);
    const env = await makeEnvForRun({
      runId: "run-undeclared",
      definition,
      materialize,
    });

    const handle = runtimeRun(definition, env, { runId: "run-undeclared" });
    const result = await handle.complete;
    expect(result.terminalStatus).toBe("failed");
    expect(counter.runs).toBe(0);
    const failure = result.events.find((e) => e.kind === "StepFailed");
    expect(JSON.stringify(failure)).toContain(
      "not in its declared requires set",
    );
  });

  test("a handler ref no action step declares is refused loudly and fails the run", async () => {
    const counter = { runs: 0 };
    const materialize: MaterializeStepTools = async () => ({
      factories: [countingEchoFactory("probe_echo", counter)],
      pluginFactories: [],
    });
    const definition = probeDefinition("probe_echo", ["probe_echo"]);
    const env = await makeEnvForRun({
      runId: "run-unknown-ref",
      definition,
      materialize,
    });
    const invokeAction = env.invokeAction;
    if (invokeAction === undefined) {
      throw new Error("runtime env did not bind invokeAction");
    }
    await expect(
      invokeAction({
        handler: "never_registered",
        input: {},
        requires: [],
        authzContext: { runId: "run-unknown-ref", stepId: "act", attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/never_registered/);
    expect(counter.runs).toBe(0);
  });

  test("loopFns and runLoopIteration are bound; an unregistered loop-fn ref is refused", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [countingEchoFactory("probe_echo", { runs: 0 })],
      pluginFactories: [],
    });
    const definition = probeDefinition("probe_echo", ["probe_echo"]);
    const env = await makeEnvForRun({
      runId: "run-loopfns",
      definition,
      materialize,
    });
    expect(env.runLoopIteration).toBeDefined();
    const loopFns = env.loopFns;
    if (loopFns === undefined) {
      throw new Error("runtime env did not bind loopFns");
    }
    expect(() => loopFns("never_registered")).toThrow(/never_registered/);
  });
});
