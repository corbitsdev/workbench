// Step-timeout budget semantics (corbitsdev/workbench#709): `step.timeout`
// bounds active agent execution, not trigger-idle input parks. An input
// park disarms the execution timer across the wait and re-arms a fresh
// budget on resume; an overrunning active invocation still aborts.

import { describe, expect, test } from "bun:test";

import type { AgentDefinition, BaseEnv } from "@intx/agent";
import { signalName } from "@intx/types";

import { defineWorkflow, runLocal, step } from "../index";
import type { StepInvoker } from "../index";

const TIMEOUT_MS = 100;
const IDLE_PARK_MS = TIMEOUT_MS * 4;

const agent: AgentDefinition<BaseEnv> = {
  id: "timeout-probe",
  systemPrompt: "probe",
  toolFactories: [],
  capabilities: [],
  inference: { sources: [] },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for test condition");
    }
    await sleep(10);
  }
}

/** Deterministic `newId` that records every `corr` (input-park) id minted. */
function corrRecordingNewId(recorded: string[]): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    const id = `${prefix}-test-${String(n)}`;
    if (prefix === "corr") recorded.push(id);
    return id;
  };
}

describe("step timeout — input-park vs active execution", () => {
  test("an idle input park past the step timeout resumes and completes", async () => {
    const turns: unknown[] = [];
    const invokeStep: StepInvoker = async ({ resume }) => {
      turns.push(resume?.decision ?? null);
      return { output: `turn-${String(turns.length)}` };
    };
    const corrIds: string[] = [];
    const run = runLocal(
      defineWorkflow({
        id: "timeout-idle-park",
        trigger: { type: "manual" },
        steps: {
          main: step({ agent, timeout: TIMEOUT_MS, triggers: 2 }),
        },
      }),
      { invokeStep, newId: corrRecordingNewId(corrIds), runId: "run-idle" },
    );

    // Turn 1 completes fast; the step re-arms onto an input park. Sit idle
    // well past the step timeout, then deliver the second trigger.
    await waitFor(() => corrIds.length > 0, 5000);
    await sleep(IDLE_PARK_MS);
    const corr = corrIds[0];
    if (corr === undefined) throw new Error("no input-park correlation minted");
    await run.signal(signalName(corr), { text: "second trigger" });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    expect(result.outputs["main"]).toBe("turn-2");
    expect(turns.length).toBe(2);
  });

  test("an active invocation past the step timeout still aborts", async () => {
    let sawAbort = false;
    const invokeStep: StepInvoker = async ({ signal }) => {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("step aborted"));
        });
        if (signal.aborted) {
          sawAbort = true;
          reject(new Error("step aborted"));
        }
      });
      throw new Error("unreachable");
    };
    const run = runLocal(
      defineWorkflow({
        id: "timeout-active-overrun",
        trigger: { type: "manual" },
        steps: {
          main: step({ agent, timeout: TIMEOUT_MS }),
        },
      }),
      { invokeStep, runId: "run-overrun" },
    );

    const result = await run.complete;
    expect(result.terminalStatus).toBe("failed");
    expect(sawAbort).toBe(true);
  });
});
