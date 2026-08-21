// Tests for the pure half of the freeze: the reify-hash-walk sequence
// over a serialized hub-authored definition. The DB half (ensure +
// stamp, and the in-place re-freeze) is covered by
// `../test/freeze.drizzle.test.ts` against real Postgres.
import { expect, test } from "bun:test";
import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";
import { type } from "arktype";

import { projectAndWalkInertDefinition } from "./index";

const STEP_ID = "agent";

function serializedAgentDefinition(input?: {
  systemPrompt?: string;
  model?: string;
}): string {
  const agent = defineAgent({
    id: STEP_ID,
    description: "A test agent",
    systemPrompt: input?.systemPrompt ?? "You are a careful test agent.",
    tools: [],
    capabilities: [],
    inference: {
      sources:
        input?.model !== undefined
          ? [{ provider: "catalog", model: input.model }]
          : [],
    },
  });
  const definition = defineWorkflow({
    id: "wf_agent_freeze_test",
    trigger: { type: "mail", to: "freeze-test@example.test" },
    steps: {
      [STEP_ID]: step({ agent, timeout: 60_000, triggers: "unbounded" }),
    },
  });
  return JSON.stringify(definition);
}

test("the frozen hash is computed over the inert projection, not the raw JSON", async () => {
  const workflowJson = serializedAgentDefinition({ model: "claude-test" });
  const frozen = await projectAndWalkInertDefinition(workflowJson);
  expect(frozen.wireHash).toBe(
    await computeWireDefinitionHash(frozen.projection),
  );
  // The raw serialized definition is a different preimage (the projector
  // flattens the inference chain), so hashing it would freeze a hash
  // that addresses content no launch-time reader can recover.
  expect(frozen.wireHash).not.toBe(
    await computeWireDefinitionHash(JSON.parse(workflowJson)),
  );
});

test("the projection carries the launch body the folded reader needs", async () => {
  const frozen = await projectAndWalkInertDefinition(
    serializedAgentDefinition({
      systemPrompt: "Answer briefly.",
      model: "claude-test",
    }),
  );
  const projected = type({
    kind: "'step'",
    agent: {
      systemPrompt: "string",
      modelSources: type({ provider: "string", model: "string" }).array(),
    },
  }).assert(frozen.projection.steps[STEP_ID]);
  expect(projected.agent.systemPrompt).toBe("Answer briefly.");
  expect(projected.agent.modelSources).toEqual([
    { provider: "catalog", model: "claude-test" },
  ]);
});

test("the grant snapshot preserves per-step grouping and the grants flatten to their sorted union", async () => {
  const frozen = await projectAndWalkInertDefinition(
    serializedAgentDefinition(),
  );
  expect(frozen.grantSnapshot.perStep.map((s) => s.stepId)).toEqual([STEP_ID]);
  const union = [
    ...new Set(frozen.grantSnapshot.perStep.flatMap((s) => s.grants)),
  ].sort();
  expect([...frozen.grants]).toEqual(union);
  expect(frozen.grantSnapshot.grantRequirements).toEqual([]);
});

test("the mail trigger's authority lands in the walked grant set", async () => {
  const frozen = await projectAndWalkInertDefinition(
    serializedAgentDefinition(),
  );
  expect(frozen.grants.some((grant) => grant.startsWith("mail."))).toBe(true);
});

test("a serialization missing its load-bearing top level fails loud", async () => {
  await expect(
    projectAndWalkInertDefinition(JSON.stringify({ id: "wf_broken" })),
  ).rejects.toThrow("malformed");
});
