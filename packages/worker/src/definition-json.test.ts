// The worker definition's single-step, mail-triggered shape is contract, not
// style: a second step silently trades away the warm agent's durable memory,
// and an `awaitSignal` gate parks the run forever on a signal nothing raises.
// CL-9712 fixed a deployment that shipped exactly that broken shape
// (`kickoff: awaitSignal({ name: "worker-kickoff" })` then the worker step
// gated on `after: ["kickoff"]`); these tests pin the deployed entry
// `buildWorkerWorkflow` so the deploy path cannot reintroduce it.
import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { buildWorkerWorkflow } from "./index";
import { WORKER_STEP_ID, WORKER_WORKFLOW_ID } from "./workflow-ids";

// The definition's shape at the trust boundary: every field the regression
// guard (and the harness that ships it) actually reads. Unknown fields are
// allowed but this schema is the source of truth for the asserted ones.
const WorkerDefinitionShape = type({
  id: "string",
  triggers: [{ type: "'mail'", to: "string" }],
  stepOrder: "string[]",
  steps: {
    worker: {
      kind: "'step'",
      id: "'worker'",
      triggers: "'unbounded'",
      "input?": { from: "'trigger.payload'" },
    },
  },
});

type WorkerJson = typeof WorkerDefinitionShape.infer;

function workerJson(triggerAddress = "worker@acme.test"): WorkerJson {
  const definition = buildWorkerWorkflow({
    workflowId: WORKER_WORKFLOW_ID,
    triggerAddress,
    inferencePreferences: [{ provider: "noop", model: "noop" }],
    systemPrompt: "You are the worker.",
    hubCredentialId: "cred_1",
    mcpServers: [],
  });
  const parsed = WorkerDefinitionShape(definition);
  if (parsed instanceof type.errors) {
    throw new Error(`definition does not match the worker shape: ${parsed.message}`);
  }
  return parsed;
}

describe("worker definition shape (CL-9712)", () => {
  test("is triggered by mail to the worker address", () => {
    expect(workerJson("worker@acme.test").triggers).toEqual([
      { type: "mail", to: "worker@acme.test" },
    ]);
  });

  test("carries exactly the worker step and no kickoff gate", () => {
    const def = workerJson();
    expect(def.stepOrder).toEqual([WORKER_STEP_ID]);
    expect(Object.keys(def.steps)).toEqual([WORKER_STEP_ID]);
    expect(def.steps[WORKER_STEP_ID]).toMatchObject({ kind: "step", id: WORKER_STEP_ID });
  });

  test("runs the worker step unbounded on the triggering mail's payload", () => {
    const worker = workerJson().steps[WORKER_STEP_ID];
    expect(worker).toBeDefined();
    if (worker === undefined) throw new Error(`missing ${WORKER_STEP_ID} step`);
    expect(worker.triggers).toBe("unbounded");
    expect(worker.input).toEqual({ from: "trigger.payload" });
  });
});
