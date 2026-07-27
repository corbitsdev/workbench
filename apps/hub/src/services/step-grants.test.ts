import { describe, expect, test } from "bun:test";
import { evaluateGrants } from "@intx/authz";
import { defineAgent } from "@intx/agent";
import { action, defineWorkflow, map, step } from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import { assembleWorkflowDeployConfig } from "./workflow-deploy-config";
import { frameGrantRules } from "./step-grants";

// A minimal StepPrimitive whose agent declares one tool capability and no
// inference sources — the shape a map's inner step needs (`MapPrimitive.step`
// is typed `StepPrimitive`, not the broader `Primitive` union, so a map body
// can never be a native `action`). Built directly here rather than through a
// retired `deterministicToolStep` helper: this test exercises `frameGrantRules`
// reading a map's inner `step.agent.capabilities`, not any dispatch mechanism.
function toolCapabilityStep(id: string, tool: string): StepPrimitive {
  return step({
    agent: defineAgent({
      id,
      description: `test fixture: ${tool}`,
      systemPrompt: "",
      tools: [],
      capabilities: [tool],
      inference: { sources: [] },
    }),
  });
}

// The production failure this pins: heartbeat/last30days action steps threw
// "action effect @workbench/tools-last30days/core:<name> was not authorized
// (null)" on every run, because the supervisor deploy frame's
// HarnessConfig.grants was hard-coded [] — and the frame's grants are what
// the sidecar writes into every step's state/grants.json, i.e. the set the
// workflow child's authorize/EffectContext actually evaluates. The hub-side
// per-step grant files were a dead path for actions.
const EFFECT_NAME =
  "@workbench/tools-last30days/core:last30days_ground_queries";
// A sibling tool staged by the SAME factory (@workbench/tools-last30days/core)
// as EFFECT_NAME — heartbeat_format_brief_title moved to its own
// @workbench/tools-heartbeat package, so last30days_collect is now
// the co-located fixture proving the whole package's surface stages, not just
// declared names.
const SIBLING_EFFECT_NAME =
  "@workbench/tools-last30days/core:last30days_collect";

function actionDefinition() {
  return defineWorkflow({
    id: "frame-grants-test",
    trigger: { type: "manual" },
    steps: {
      ground: action({
        handler: EFFECT_NAME,
        effect: { requires: [EFFECT_NAME] },
      }),
    },
  });
}

describe("frameGrantRules", () => {
  test("an action's declared effect authorizes through the real evaluator", async () => {
    const rules = frameGrantRules(actionDefinition());
    const granted = await evaluateGrants(
      rules,
      `effect:${EFFECT_NAME}`,
      "invoke",
    );
    expect(granted.effect).toBe("allow");
  });

  test("the staged package's whole canonical surface is covered, not just declared names", async () => {
    const rules = frameGrantRules(actionDefinition());
    const sibling = await evaluateGrants(
      rules,
      `effect:${SIBLING_EFFECT_NAME}`,
      "invoke",
    );
    expect(sibling.effect).toBe("allow");
  });
});

describe("frameGrantRules over map primitives", () => {
  // Regression pin: a MapPrimitive carries its agent at `step.agent`, not at
  // the primitive's top level, and has no `body`. The first defensive
  // collector read only `agent`/`effect`/`body`, so a workflow whose ONLY
  // tool-bearing step is a map (pain-point-collateral's persist,
  // reddit-opportunity-scanner's collect/persist) contributed NOTHING to the
  // frame grants — reproducing the exact "not authorized (null)" class the
  // frame-grants fix shipped to close.
  test("a workflow whose only tool-bearing step is a map still grants that tool", async () => {
    const definition = defineWorkflow({
      id: "map-grants-test",
      trigger: { type: "manual" },
      steps: {
        persist: map({
          over: { from: "trigger.payload" },
          step: toolCapabilityStep(
            "map-grants-persist",
            "@workbench/tools-artifact/artifact:artifact_create",
          ),
        }),
      },
    });
    const rules = frameGrantRules(definition);
    const granted = await evaluateGrants(
      rules,
      "tool:@workbench/tools-artifact/artifact:artifact_create",
      "invoke",
    );
    expect(granted.effect).toBe("allow");
  });
});

describe("assembleWorkflowDeployConfig frame grants", () => {
  test("the supervisor frame carries the definition's grant rules — never an empty array", async () => {
    const { config } = assembleWorkflowDeployConfig({
      deploymentId: "dep_test",
      tenantId: "t-1",
      principalId: "p-1",
      deploymentDomain: "workbench.example",
      sources: [
        {
          id: "src-1",
          provider: "openai-compatible",
          model: "deepseek-v4-flash",
        } as never,
      ],
      definition: actionDefinition(),
    });
    expect(config.grants.length).toBeGreaterThan(0);
    const granted = await evaluateGrants(
      config.grants as never,
      `effect:${EFFECT_NAME}`,
      "invoke",
    );
    expect(granted.effect).toBe("allow");
  });
});
