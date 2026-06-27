// CL-2535: prove an awaitSignal-parked run survives a sidecar restart.
//
// Baseline mirrors interchange's own `resume-awaiting-signal.test.ts` (the
// runtime refuses a parked tail). The remaining tests invert it: after the
// host satisfies the gate from the durable signal (`hostSatisfyAwaitSignal`),
// `runtimeRun` resumes the same log to `RunCompleted` — and a downstream step
// actually executes, proving the run CONTINUES rather than just settles.

import { describe, test, expect } from "bun:test";

import { createDefaultDirectorRegistry, defineAgent } from "@intx/agent";
import {
  awaitSignal,
  createInMemoryBlobSubstrate,
  createInMemoryRepoStore,
  createInMemoryScheduler,
  createInMemorySignalChannel,
  createNoopDrainController,
  defineWorkflow,
  runtimeRun,
  RuntimeResumeUnsupportedError,
  step,
  type BlobSubstrate,
  type RunResult,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";

import {
  hostSatisfyAwaitSignal,
  recoverParkedRunFromLog,
} from "./workflow-resume";

const RUN_ID = "run-resume-test";

function makeAgent(id: string) {
  return defineAgent({
    id,
    systemPrompt: `you are ${id}`,
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "fake", model: "fake" }] },
  });
}

// A run parked at an `awaitSignal` gate named "go": RunStarted, the gate's
// StepStarted, and SignalAwaited — exactly the durable tail a sidecar restart
// leaves behind.
function parkedSeed(at: string): WorkflowEvent[] {
  return [
    {
      kind: "RunStarted",
      seq: 1,
      at,
      runId: RUN_ID,
      definitionHash: "x",
      trigger: { type: "manual", payload: undefined },
    },
    {
      kind: "StepStarted",
      seq: 2,
      at,
      stepId: "gate",
      attempt: 1,
      input: { ref: "inline:null" },
    },
    {
      kind: "SignalAwaited",
      seq: 3,
      at,
      stepId: "gate",
      signalName: "go",
    },
  ];
}

function makeEnv(opts?: {
  blobs?: BlobSubstrate;
  onInvoke?: (stepId: string) => void;
}): WorkflowRuntimeEnv {
  const clock = () => new Date();
  const repoStore = createInMemoryRepoStore();
  return {
    repoStore,
    scheduler: createInMemoryScheduler({ repoStore, clock }),
    signalChannel: createInMemorySignalChannel(),
    blobs: opts?.blobs ?? createInMemoryBlobSubstrate(),
    directors: createDefaultDirectorRegistry(),
    authorize: async () => ({
      effect: "allow",
      matchingGrants: [],
      resolvedBy: null,
    }),
    invokeStep: async (input) => {
      opts?.onInvoke?.(input.agent.id);
      return { output: { ran: input.agent.id } };
    },
    spawnChild: async () => ({ terminalStatus: "completed" }),
    clock,
    newId: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
    drain: createNoopDrainController({} as WorkflowDefinition),
  };
}

describe("host-satisfied awaitSignal resume (CL-2535)", () => {
  test("baseline: an unsatisfied parked tail still throws RuntimeResumeUnsupportedError", async () => {
    const def = defineWorkflow({
      id: "gate-only",
      trigger: { type: "manual" },
      steps: { gate: awaitSignal({ name: "go" }) },
    });
    const env = makeEnv();
    await expect(
      runtimeRun(def, env, {
        runId: RUN_ID,
        resumeFromEvents: parkedSeed(new Date().toISOString()),
      }).complete,
    ).rejects.toBeInstanceOf(RuntimeResumeUnsupportedError);
  });

  test("host-satisfied gate resumes to RunCompleted, and the gate output resolves (blob fidelity)", async () => {
    const def = defineWorkflow({
      id: "gate-only",
      trigger: { type: "manual" },
      steps: { gate: awaitSignal({ name: "go" }) },
    });
    const blobs = createInMemoryBlobSubstrate();
    const env = makeEnv({ blobs });
    const payload = { approved: true, note: "looks good" };

    // Same `blobs` the resumed runtime reads — the StepCompleted ref must
    // round-trip through it.
    const satisfied = await hostSatisfyAwaitSignal({
      runId: RUN_ID,
      log: parkedSeed(new Date().toISOString()),
      signal: { signalName: "go", signalId: "sig-1", payload },
      blobs,
    });

    const result: RunResult = await runtimeRun(def, env, {
      runId: RUN_ID,
      resumeFromEvents: satisfied,
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    // The host-written output blob resolves on the resumed run.
    expect(result.outputs.gate).toEqual(payload);
  });

  test("downstream step executes after resume (the run CONTINUES, not just settles)", async () => {
    const def = defineWorkflow({
      id: "gate-then-done",
      trigger: { type: "manual" },
      steps: {
        gate: awaitSignal({ name: "go" }),
        done: step({ agent: makeAgent("done"), after: ["gate"] }),
      },
    });
    const blobs = createInMemoryBlobSubstrate();
    const invoked: string[] = [];
    const env = makeEnv({ blobs, onInvoke: (id) => invoked.push(id) });

    const satisfied = await hostSatisfyAwaitSignal({
      runId: RUN_ID,
      log: parkedSeed(new Date().toISOString()),
      signal: { signalName: "go", signalId: "sig-1", payload: { ok: true } },
      blobs,
    });

    const result: RunResult = await runtimeRun(def, env, {
      runId: RUN_ID,
      resumeFromEvents: satisfied,
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    // The gate never goes through invokeStep; `done` (a real step) does —
    // proving downstream work ran on the resumed run.
    expect(invoked).toContain("done");
    expect(invoked).not.toContain("gate");
  });

  // The production hook path: the hub already committed `SignalReceived` to the
  // log (the gate is `in-flight` on resume) but the runtime died before
  // `StepCompleted`. recoverParkedRunFromLog finishes the gate from the
  // already-durable signal.
  test("recoverParkedRunFromLog completes an already-received gate and resumes", async () => {
    const def = defineWorkflow({
      id: "gate-only",
      trigger: { type: "manual" },
      steps: { gate: awaitSignal({ name: "go" }) },
    });
    const blobs = createInMemoryBlobSubstrate();
    const env = makeEnv({ blobs });
    const payload = { approved: true };
    const at = new Date().toISOString();
    // Signal delivered (committed) but no StepCompleted — the crash window.
    const deliveredLog: WorkflowEvent[] = [
      ...parkedSeed(at),
      {
        kind: "SignalReceived",
        seq: 4,
        at,
        signalName: "go",
        signalId: "sig-1",
        payload,
      },
    ];

    const recovered = await recoverParkedRunFromLog({
      log: deliveredLog,
      blobs,
    });
    expect(recovered).not.toBeNull();

    const result: RunResult = await runtimeRun(def, env, {
      runId: RUN_ID,
      resumeFromEvents: recovered!,
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    expect(result.outputs.gate).toEqual(payload);
  });

  test("recoverParkedRunFromLog returns null when the gate is still awaiting (no signal delivered)", async () => {
    const blobs = createInMemoryBlobSubstrate();
    const recovered = await recoverParkedRunFromLog({
      log: parkedSeed(new Date().toISOString()),
      blobs,
    });
    expect(recovered).toBeNull();
  });

  // Double-restart consistency. The runtime treats the resume seed as already
  // durable and does NOT re-commit the host-appended StepCompleted, so a crash
  // before any downstream event commits leaves the durable log unchanged and a
  // second restart re-scans the same log. Recovery must be a consistent,
  // idempotent retry: each restart resumes the gate to completion identically.
  test("recoverParkedRunFromLog resolves consistently across a double restart", async () => {
    const def = defineWorkflow({
      id: "gate-only",
      trigger: { type: "manual" },
      steps: { gate: awaitSignal({ name: "go" }) },
    });
    const payload = { approved: true };
    const at = new Date().toISOString();
    const durableLog: WorkflowEvent[] = [
      ...parkedSeed(at),
      {
        kind: "SignalReceived",
        seq: 4,
        at,
        signalName: "go",
        signalId: "sig-1",
        payload,
      },
    ];

    // Two independent restarts re-scanning the SAME durable log (fresh blob
    // substrate each time = a fresh process), both resume to completed.
    for (let restart = 0; restart < 2; restart++) {
      const blobs = createInMemoryBlobSubstrate();
      const env = makeEnv({ blobs });
      const recovered = await recoverParkedRunFromLog({
        log: durableLog,
        blobs,
      });
      expect(recovered).not.toBeNull();
      const result: RunResult = await runtimeRun(def, env, {
        runId: RUN_ID,
        resumeFromEvents: recovered!,
      }).complete;
      expect(result.terminalStatus).toBe("completed");
      expect(result.outputs.gate).toEqual(payload);
    }
  });
});
