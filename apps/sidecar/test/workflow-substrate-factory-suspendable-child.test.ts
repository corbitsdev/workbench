// An onTrigger body child, spawned through the real sidecar seam, parks on
// an approval and resumes on the correlated grant.
//
// `createSidecarSpawnSuspendableChild` runs the body definition against a
// real on-disk workflow-run substrate and hands back the live handle
// `runOnTrigger` drives. This test exercises that handle end to end: the
// body step's injected `invokeStep` suspends as an approval, so the child
// runtime parks on the reserved correlation channel; `handle.next()`
// surfaces the park with the step's snapshot; `handle.resume` delivers the
// grant on the child's own signal channel, and the re-invoked step
// completes the run. Runtime park/resume mechanics themselves are the
// published packages' concern -- what is proven here is OUR handle wiring:
// the park FIFO, the resume delivery, and the terminal surfacing.

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { ApprovalSnapshot, KeyPair } from "@intx/types/runtime";
import { defineAgent } from "@intx/agent";
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
  createInMemoryRepoStore,
  createInMemoryScheduler,
  defineWorkflow,
  step,
  type StepInvoker,
  type WorkflowDefinition,
} from "@intx/workflow";

import {
  createSidecarSpawnSuspendableChild,
  type SidecarBodyStepInvoker,
} from "../src/workflow-substrate-factory";

const REF = "refs/heads/main";
const DEPLOYMENT_ID = "deployment-suspendable-child";
const WORKFLOW_RUN_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: DEPLOYMENT_ID,
};
const allowAll: AuthorizeFn = () => ({ allowed: true });
const PRINCIPAL: WorkflowRunWorkflowProcessPrincipal = {
  kind: "workflow-process",
  anchorRunId: DEPLOYMENT_ID,
};

const BODY_STEP_AGENT_ID = "wallet-spend";
const CORRELATION_ID = "corr-approval-1";
const SNAPSHOT: ApprovalSnapshot = {
  name: BODY_STEP_AGENT_ID,
  description: "spend from the shared wallet",
  inputSchema: { amount: "number" },
  arguments: { amount: 100 },
};

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

async function makeTempDir(prefix: string): Promise<string> {
  const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

// The one-step body definition every spawn runs. Its single step's injected
// invoker suspends as an approval on the first invocation and completes on
// the resume re-invocation.
function bodyDefinition(id: string): WorkflowDefinition {
  const agent = defineAgent({
    id: BODY_STEP_AGENT_ID,
    systemPrompt: "s",
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "anthropic", model: "m" }] },
  });
  return defineWorkflow({
    id,
    trigger: { type: "manual" },
    steps: { s: step({ agent }) },
  });
}

async function makeSubstrate(
  prefix: string,
): Promise<ReturnType<typeof createRepoStore>> {
  const dataDir = await makeTempDir(prefix);
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

// An invoker that suspends as an approval on its first invocation and, on
// the resume re-invocation, records the delivered decision and completes.
function suspendThenComplete(record: {
  resumeDecision?: unknown;
}): StepInvoker {
  return async (req) => {
    if (req.resume === undefined) {
      return {
        suspend: {
          correlationId: CORRELATION_ID,
          kind: "approval",
          approvalSnapshot: SNAPSHOT,
        },
      };
    }
    record.resumeDecision = req.resume.decision;
    return { output: { echoed: req.resume.decision } };
  };
}

function makeSpawner(
  substrate: ReturnType<typeof createRepoStore>,
  invokeStep: StepInvoker,
): ReturnType<typeof createSidecarSpawnSuspendableChild> {
  return createSidecarSpawnSuspendableChild({
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    principal: PRINCIPAL,
    scheduler: createInMemoryScheduler({
      repoStore: createInMemoryRepoStore(),
      clock: () => new Date(),
    }),
    invokeStep,
  });
}

describe("createSidecarSpawnSuspendableChild", () => {
  test("surfaces a body approval park, resumes on the grant, and completes", async () => {
    const substrate = await makeSubstrate("suspendable-approval-");

    const record: { resumeDecision?: unknown } = {};
    const spawn = makeSpawner(substrate, suspendThenComplete(record));

    const handle = await spawn(
      {
        definition: bodyDefinition("body-wf"),
        definitionRef: REF,
        childRunId: "run-body-0",
        input: { text: "event-0" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: new AbortController().signal,
      },
      () => undefined,
    );

    // The body step suspended -> the handle surfaces the approval park on
    // the reserved correlation, carrying the step's snapshot.
    const parked = await handle.next();
    expect(parked.kind).toBe("park");
    if (parked.kind !== "park") throw new Error("expected a park");
    expect(parked.park.correlationId).toBe(CORRELATION_ID);
    expect(parked.park.approvalSnapshot).toEqual(SNAPSHOT);

    // Grant it: resume delivers the decision on the child's own signal
    // channel, unblocking the parked step.
    const decision = { outcome: "approved" as const, note: "ok" };
    await handle.resume(CORRELATION_ID, decision);

    // The re-invoked step ran with the delivered decision and the run
    // completed.
    const terminal = await handle.next();
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind !== "terminal") throw new Error("expected a terminal");
    expect(terminal.terminalStatus).toBe("completed");
    expect(record.resumeDecision).toEqual(decision);
  });

  test("a wired body invoker runs the body step with the on-disk sources", async () => {
    const substrate = await makeSubstrate("suspendable-body-invoker-");

    // The per-body pins the deploy router materializes beside the body's
    // workflow.json; the spawn must read exactly this file to build the
    // body's sources ref.
    const bodySources = {
      s: [
        {
          id: "s",
          provider: "anthropic",
          baseURL: "https://api.anthropic.com",
          apiKey: "sk-body",
          model: "claude-3-5",
        },
      ],
    };
    const dataDir = await makeTempDir("suspendable-body-datadir-");
    const sourcesDir = path.join(dataDir, "assets", "workflow", "body-wf-real");
    await fs.promises.mkdir(sourcesDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourcesDir, "sources.json"),
      JSON.stringify(bodySources),
    );

    const seen: { sources?: unknown; agentId?: string } = {};
    const bodyInvokeStep: SidecarBodyStepInvoker = async (
      req,
      _authorize,
      sourcesRef,
    ) => {
      seen.sources = sourcesRef.current;
      seen.agentId = req.agent.id;
      return { output: { done: true } };
    };
    const spawn = createSidecarSpawnSuspendableChild({
      substrate,
      workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
      workflowRunRef: REF,
      principal: PRINCIPAL,
      scheduler: createInMemoryScheduler({
        repoStore: createInMemoryRepoStore(),
        clock: () => new Date(),
      }),
      invokeStep: () => {
        throw new Error(
          "the body step must route through bodyInvokeStep, not the childWorkflow stub",
        );
      },
      bodyInvokeStep,
      dataDir,
    });

    const handle = await spawn(
      {
        definition: bodyDefinition("body-wf-real"),
        definitionRef: REF,
        childRunId: "run-body-2",
        input: { text: "event-2" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: new AbortController().signal,
      },
      () => undefined,
    );

    const terminal = await handle.next();
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind !== "terminal") throw new Error("expected a terminal");
    expect(terminal.terminalStatus).toBe("completed");
    // The invoker ran the body's own step and saw the sources read off
    // disk -- readBodyStepInferenceSources fed the ref, not the parent's
    // pinned table.
    expect(seen.agentId).toBe(BODY_STEP_AGENT_ID);
    expect(seen.sources).toEqual(bodySources);
  });

  // CL-6448: the body-turn tool seam. The spawn input threads the parent
  // child's credentials-backed authorize and live credential wiring; the
  // body invoker must receive exactly those, so a body agent's tool calls
  // gate through the parent's per-step grant snapshot instead of the
  // throwing stub.
  test("the spawn input's authorize and credentialWiring reach the body invoker", async () => {
    const substrate = await makeSubstrate("suspendable-body-authorize-");
    const dataDir = await makeTempDir("suspendable-body-authz-datadir-");
    const sourcesDir = path.join(
      dataDir,
      "assets",
      "workflow",
      "body-wf-authz",
    );
    await fs.promises.mkdir(sourcesDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourcesDir, "sources.json"),
      JSON.stringify({
        s: [
          {
            id: "s",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com",
            apiKey: "sk-body",
            model: "claude-3-5",
          },
        ],
      }),
    );

    const threadedAuthorize = () =>
      Promise.resolve({ effect: "allow" as const });
    const threadedWiring = {
      materialRef: { current: null },
      resolveStepGrants: () => [],
    };
    const seen: { authorize?: unknown; credentialWiring?: unknown } = {};
    const bodyInvokeStep: SidecarBodyStepInvoker = async (
      _req,
      authorize,
      _sourcesRef,
      _onEvent,
      credentialWiring,
    ) => {
      seen.authorize = authorize;
      seen.credentialWiring = credentialWiring;
      return { output: { done: true } };
    };
    const spawn = createSidecarSpawnSuspendableChild({
      substrate,
      workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
      workflowRunRef: REF,
      principal: PRINCIPAL,
      scheduler: createInMemoryScheduler({
        repoStore: createInMemoryRepoStore(),
        clock: () => new Date(),
      }),
      invokeStep: () => {
        throw new Error("must route through bodyInvokeStep");
      },
      bodyInvokeStep,
      dataDir,
    });

    const handle = await spawn(
      {
        definition: bodyDefinition("body-wf-authz"),
        definitionRef: REF,
        childRunId: "run-body-3",
        input: { text: "event-3" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: new AbortController().signal,
        authorize: threadedAuthorize as never,
        credentialWiring: threadedWiring as never,
      },
      () => undefined,
    );

    const terminal = await handle.next();
    expect(terminal.kind).toBe("terminal");
    expect(seen.authorize).toBe(threadedAuthorize);
    expect(seen.credentialWiring).toBe(threadedWiring);
  });

  test("a parent abort while parked cancels the child and surfaces a terminal", async () => {
    const substrate = await makeSubstrate("suspendable-abort-");
    const spawn = makeSpawner(substrate, suspendThenComplete({}));

    const abort = new AbortController();
    const handle = await spawn(
      {
        definition: bodyDefinition("body-wf-abort"),
        definitionRef: REF,
        childRunId: "run-body-1",
        input: { text: "event-1" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: abort.signal,
      },
      () => undefined,
    );

    const parked = await handle.next();
    expect(parked.kind).toBe("park");

    abort.abort();

    const terminal = await handle.next();
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind !== "terminal") throw new Error("expected a terminal");
    expect(terminal.terminalStatus).toBe("cancelled");
  });
});
