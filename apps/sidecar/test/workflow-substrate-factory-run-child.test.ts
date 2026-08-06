// A terminal-only child workflow, run through `createSidecarRunChild` --
// the independently constructed seam `spawnChild` delegates to, distinct
// from the suspendable-child path. The callback awaits a single terminal,
// so what is proven here is OUR abort wiring on that path: the
// parent-supplied `AbortSignal` reaches the child's cancel cascade and the
// callback resolves with `terminalStatus: "cancelled"` -- both for an
// abort that fires mid-run (while the child is parked with nothing to
// resume it) and for a signal that is already aborted when the callback
// observes it. The completion control keeps those cancels honest: the
// same seam resolves "completed" when nothing aborts.

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
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
import type { RunChildWorkflow } from "@intx/workflow-host";

import { createSidecarRunChild } from "../src/workflow-substrate-factory";

const REF = "refs/heads/main";
const DEPLOYMENT_ID = "deployment-run-child";
const WORKFLOW_RUN_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: DEPLOYMENT_ID,
};
const allowAll: AuthorizeFn = () => ({ allowed: true });
const PRINCIPAL: WorkflowRunWorkflowProcessPrincipal = {
  kind: "workflow-process",
  deploymentId: DEPLOYMENT_ID,
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

// The one-step child definition every run uses; its injected invoker
// decides whether the step completes or parks forever.
function childDefinition(id: string): WorkflowDefinition {
  const agent = defineAgent({
    id: "child-step",
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

// Parks on a correlation nothing will ever resume: the run can only end
// through the cancel cascade, so a resolved terminal proves the abort
// wiring rather than a step that happened to finish first.
const parkForever: StepInvoker = async () => ({
  suspend: {
    correlationId: "corr-never-resumed",
    kind: "approval" as const,
    approvalSnapshot: {
      name: "child-step",
      description: "never granted",
      inputSchema: {},
      arguments: {},
    },
  },
});

const completeImmediately: StepInvoker = async () => ({
  output: { done: true },
});

async function makeRunChild(
  prefix: string,
  invokeStep: StepInvoker,
): Promise<RunChildWorkflow> {
  const substrate = await makeSubstrate(prefix);
  return createSidecarRunChild({
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    workflowDefinitionRef: REF,
    principal: PRINCIPAL,
    scheduler: createInMemoryScheduler({
      repoStore: createInMemoryRepoStore(),
      clock: () => new Date(),
    }),
    invokeStep,
  });
}

function childInput(
  id: string,
  signal: AbortSignal,
): Parameters<RunChildWorkflow>[0] {
  return {
    definition: childDefinition(`child-wf-${id}`),
    definitionRef: REF,
    childRunId: `run-child-${id}`,
    input: { text: "event" },
    parentRunId: "run-parent",
    parentStepId: "section",
    signal,
  };
}

describe("createSidecarRunChild", () => {
  test("an unaborted child runs to a completed terminal", async () => {
    const runChild = await makeRunChild(
      "run-child-complete-",
      completeImmediately,
    );
    const result = await runChild(
      childInput("complete", new AbortController().signal),
    );
    expect(result.terminalStatus).toBe("completed");
  });

  test("a parent abort mid-run cancels the child and resolves cancelled", async () => {
    const runChild = await makeRunChild("run-child-abort-", parkForever);
    const abort = new AbortController();
    const pending = runChild(childInput("abort", abort.signal));

    // Let the child reach its park before the abort fires so the cancel
    // demonstrably interrupts a run in flight rather than one still
    // starting up.
    await Bun.sleep(50);
    abort.abort();

    const result = await pending;
    expect(result.terminalStatus).toBe("cancelled");
  });

  test("a signal already aborted at invocation resolves cancelled", async () => {
    const runChild = await makeRunChild("run-child-preabort-", parkForever);
    const abort = new AbortController();
    abort.abort();
    const result = await runChild(childInput("preabort", abort.signal));
    expect(result.terminalStatus).toBe("cancelled");
  });
});
