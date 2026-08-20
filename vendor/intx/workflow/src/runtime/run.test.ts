// `onTrigger`'s non-fatal body-failure edge (`onBodyFailure`).
//
// These are unit tests of the runtime state machine, not the sidecar
// wiring: `runtimeRun` is exercised directly against a hand-built
// `WorkflowRuntimeEnv` (the same in-memory pieces `runLocal` wires,
// plus a fake `spawnSuspendableChild` this file controls per
// `childRunId`) rather than through `runLocal`, which does not expose a
// `spawnSuspendableChild` override. No real agent or substrate is
// involved -- this is the "runtime/run.test.ts" the discipline comment
// in `runlocal/run-local.ts` names as the intended home for this
// coverage.

import { describe, test, expect } from "bun:test";

import { createDefaultDirectorRegistry } from "@intx/agent";

import type { OnTriggerPrimitive } from "../definition/primitives";
import type { WorkflowDefinition } from "../definition/workflow";
import { createInMemoryBlobSubstrate } from "../runlocal/blob-substrate";
import { createInMemoryRepoStore } from "../runlocal/repo-store";
import { createInMemoryScheduler } from "../runlocal/scheduler";
import { createInMemorySignalChannel } from "../runlocal/signal-channel";
import { createNoopDrainController } from "./drain";
import { runtimeRun } from "./run";
import type {
  SpawnSuspendableChild,
  SuspendableChildHandle,
  WorkflowRuntimeEnv,
} from "./env";
import {
  controlParkKindOf,
  resumeFromLog,
  type RunState,
  type WorkflowEvent,
} from "../state-machine/index";

const SECTION_ID = "section";

function definitionWith(
  onTriggerOverrides: Partial<OnTriggerPrimitive> = {},
): WorkflowDefinition {
  const primitive: OnTriggerPrimitive = {
    kind: "onTrigger",
    id: SECTION_ID,
    on: { type: "manual" },
    body: { ref: "test-body" },
    ...onTriggerOverrides,
  };
  return {
    id: "wf-onbodyfailure",
    triggers: [{ type: "manual" }],
    steps: { [SECTION_ID]: primitive },
    stepOrder: [SECTION_ID],
  };
}

type TerminalStatus = "completed" | "failed" | "cancelled";

/**
 * A fake `spawnSuspendableChild` keyed by `childRunId`, each occurrence
 * settling immediately on the terminal status the test scripted for it.
 * `resume`/`deliverSignal` are unused by every scenario here (no body
 * ever parks) so they throw if called, matching the pattern
 * `apps/sidecar/test/workflow-substrate-factory-suspendable-child.test.ts`
 * uses for handle members a scenario does not exercise.
 */
function fakeSpawn(
  responses: Record<string, TerminalStatus>,
): { spawn: SpawnSuspendableChild; spawnedChildRunIds: string[] } {
  const spawnedChildRunIds: string[] = [];
  const spawn: SpawnSuspendableChild = async ({ childRunId }) => {
    spawnedChildRunIds.push(childRunId);
    const terminalStatus = responses[childRunId];
    if (terminalStatus === undefined) {
      throw new Error(`fakeSpawn: no scripted response for ${childRunId}`);
    }
    let delivered = false;
    const handle: SuspendableChildHandle = {
      async next() {
        if (delivered) {
          throw new Error(
            `fakeSpawn: ${childRunId} next() called more than once`,
          );
        }
        delivered = true;
        return { kind: "terminal", terminalStatus };
      },
      async resume() {
        throw new Error(`fakeSpawn: ${childRunId} unexpected resume()`);
      },
      async deliverSignal() {
        throw new Error(`fakeSpawn: ${childRunId} unexpected deliverSignal()`);
      },
    };
    return handle;
  };
  return { spawn, spawnedChildRunIds };
}

function buildEnv(spawn: SpawnSuspendableChild): WorkflowRuntimeEnv {
  const repoStore = createInMemoryRepoStore();
  const clock = () => new Date();
  let idCounter = 0;
  const newId = (prefix: string): string => {
    idCounter += 1;
    return `${prefix}-${String(idCounter)}`;
  };
  const definitionForDrain = definitionWith();
  return {
    repoStore,
    scheduler: createInMemoryScheduler({ repoStore, clock }),
    signalChannel: createInMemorySignalChannel({ newId: () => newId("sig") }),
    blobs: createInMemoryBlobSubstrate(),
    directors: createDefaultDirectorRegistry(),
    authorize: async () => ({
      effect: "allow",
      matchingGrants: [],
      resolvedBy: null,
    }),
    invokeStep: async () => {
      throw new Error("no step primitive is exercised by these tests");
    },
    spawnChild: async () => {
      throw new Error("no childWorkflow primitive is exercised by these tests");
    },
    spawnSuspendableChild: spawn,
    clock,
    newId,
    drain: createNoopDrainController(definitionForDrain),
  };
}

async function readState(
  env: WorkflowRuntimeEnv,
  runId: string,
): Promise<RunState> {
  const events = await env.repoStore.read(runId);
  return resumeFromLog(runId, events);
}

/** Poll the durable log until `predicate` holds. In-memory, so this settles fast. */
async function waitFor(
  env: WorkflowRuntimeEnv,
  runId: string,
  predicate: (state: RunState) => boolean,
): Promise<RunState> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const state = await readState(env, runId);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor: predicate never became true");
}

function inputParkName(state: RunState): string | undefined {
  const container = state.steps.get(SECTION_ID);
  if (container === undefined || container.phase !== "awaiting-signal") {
    return undefined;
  }
  if (container.awaitingSignal === undefined) return undefined;
  if (controlParkKindOf(container.awaitingSignal) !== "input") return undefined;
  return container.awaitingSignal.name;
}

describe("onTrigger onBodyFailure", () => {
  test("default policy: a failed body run ends the whole section run", async () => {
    const { spawn, spawnedChildRunIds } = fakeSpawn({
      "section__0": "failed",
    });
    const env = buildEnv(spawn);
    const definition = definitionWith(); // no onBodyFailure -- default "end"

    const run = runtimeRun(definition, env, { triggerPayload: {} });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("failed");
    // The failed occurrence is still durably recorded before the throw.
    const events = await env.repoStore.read(run.runId);
    const childCompleted = events.find(
      (e): e is WorkflowEvent & { kind: "ChildCompleted" } =>
        e.kind === "ChildCompleted",
    );
    expect(childCompleted?.terminalStatus).toBe("failed");
    // The section never re-arms for a second occurrence under the default.
    expect(spawnedChildRunIds).toEqual(["section__0"]);
  });

  test('onBodyFailure: "continue" keeps the section alive through a failed occurrence', async () => {
    const { spawn } = fakeSpawn({
      "section__0": "failed",
      "section__1": "completed",
    });
    const env = buildEnv(spawn);
    const definition = definitionWith({ onBodyFailure: "continue" });

    const run = runtimeRun(definition, env, { triggerPayload: { n: 0 } });

    // The run does not settle terminal after occurrence 0 fails -- it
    // re-arms on the input park instead.
    const afterFirstFailure = await waitFor(env, run.runId, (state) =>
      inputParkName(state) !== undefined,
    );
    expect(afterFirstFailure.phase).not.toBe("failed");
    expect(afterFirstFailure.children.get("section__0")?.terminalStatus).toBe(
      "failed",
    );

    // The failed occurrence's ChildCompleted is a durable, loud audit event
    // on the run's own log -- the section did not silently swallow it.
    const eventsAfterFirstFailure = await env.repoStore.read(run.runId);
    const childCompleted = eventsAfterFirstFailure.find(
      (e): e is WorkflowEvent & { kind: "ChildCompleted" } =>
        e.kind === "ChildCompleted" && e.childRunId === "section__0",
    );
    expect(childCompleted).toBeDefined();
    expect(childCompleted?.terminalStatus).toBe("failed");

    const parkName = inputParkName(afterFirstFailure);
    if (parkName === undefined) throw new Error("expected an input park");
    await run.signal(parkName, { n: 1 });

    // Occurrence 1 spawns and succeeds normally -- the run proceeds, it
    // does not throw.
    await waitFor(
      env,
      run.runId,
      (state) => state.children.get("section__1")?.terminalStatus === "completed",
    );

    await run.cancel("self", "test cleanup");
    const result = await run.complete;
    expect(result.terminalStatus).toBe("cancelled");
  });

  test('onBodyFailure: "continue" never swallows a cancelled body run', async () => {
    const { spawn } = fakeSpawn({
      "section__0": "cancelled",
    });
    const env = buildEnv(spawn);
    const definition = definitionWith({ onBodyFailure: "continue" });

    const run = runtimeRun(definition, env, { triggerPayload: {} });
    const result = await run.complete;

    // A cancelled body run still throws terminal-is-final -- it lands the
    // section's own step as StepFailed, so the whole run's terminalStatus
    // is "failed" (a thrown primitive error, not a run-level cancel);
    // what matters here is that `onBodyFailure` did NOT swallow it into a
    // re-arm the way it does for "failed".
    expect(result.terminalStatus).toBe("failed");
    const events = await env.repoStore.read(run.runId);
    const message = events.find(
      (e): e is WorkflowEvent & { kind: "StepFailed" } => e.kind === "StepFailed",
    )?.error.message;
    expect(message).toContain("cancelled");
  });

  test("crash-recovery honors onBodyFailure: a failed-but-continuing section resumes on the input re-arm", async () => {
    // Hand-built seed log: the container's mid-flight state right after
    // occurrence 0's ChildCompleted{failed} commits, but BEFORE the
    // re-arm park lands -- the exact crash window `planOnTriggerResume`'s
    // ordering comment describes. Built by hand (rather than captured off
    // a live run) so the test is deterministic about which side of that
    // race it exercises.
    const definition = definitionWith({ onBodyFailure: "continue" });
    const seedLog: WorkflowEvent[] = [
      {
        kind: "RunStarted",
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        runId: "resume-test",
        definitionHash: "seed-hash",
        trigger: { type: "manual", payload: {} },
      },
      {
        kind: "StepStarted",
        seq: 2,
        at: "2026-01-01T00:00:00.000Z",
        stepId: SECTION_ID,
        attempt: 1,
        input: { ref: "unused-input-ref" },
      },
      {
        kind: "ChildSpawned",
        seq: 3,
        at: "2026-01-01T00:00:00.000Z",
        stepId: SECTION_ID,
        childRunId: "section__0",
        childDefinitionRef: "test-body",
      },
      {
        kind: "ChildCompleted",
        seq: 4,
        at: "2026-01-01T00:00:00.000Z",
        childRunId: "section__0",
        terminalStatus: "failed",
      },
    ];

    // Resume a fresh env from that seed log with the same policy. The
    // resume path (`planOnTriggerResume`) must take the reawait-input
    // arm, not terminal-is-final, so the section keeps going.
    const resumeSpawn = fakeSpawn({
      "section__0": "failed",
      "section__1": "completed",
    });
    const resumeEnv = buildEnv(resumeSpawn.spawn);
    const resumeRun = runtimeRun(definition, resumeEnv, {
      runId: "resume-test",
      resumeFromEvents: seedLog,
    });

    const afterResume = await waitFor(resumeEnv, resumeRun.runId, (state) =>
      inputParkName(state) !== undefined,
    );
    // Resume did not re-spawn occurrence 0's body -- it recovered position
    // from the log rather than throwing terminal-is-final.
    expect(resumeSpawn.spawnedChildRunIds).toEqual([]);
    const parkName = inputParkName(afterResume);
    if (parkName === undefined) throw new Error("expected an input park");
    await resumeRun.signal(parkName, { n: 1 });

    await waitFor(
      resumeEnv,
      resumeRun.runId,
      (state) =>
        state.children.get("section__1")?.terminalStatus === "completed",
    );

    await resumeRun.cancel("self", "test cleanup");
    const result = await resumeRun.complete;
    expect(result.terminalStatus).toBe("cancelled");
  });
});
