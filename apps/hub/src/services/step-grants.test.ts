import { describe, expect, test } from "bun:test";
import { evaluateGrants } from "@intx/authz";
import { action, defineWorkflow } from "@intx/workflow";
import { assembleWorkflowDeployConfig } from "./workflow-deploy-config";
import { frameGrantRules } from "./step-grants";

// The production failure this pins: heartbeat/last30days action steps threw
// "action effect @workbench/tools-last30days/core:<name> was not authorized
// (null)" on every run, because the supervisor deploy frame's
// HarnessConfig.grants was hard-coded [] — and the frame's grants are what
// the sidecar writes into every step's state/grants.json, i.e. the set the
// workflow child's authorize/EffectContext actually evaluates. The hub-side
// per-step grant files were a dead path for actions.
const EFFECT_NAME = "@workbench/tools-last30days/core:last30days_ground_queries";
const SIBLING_EFFECT_NAME =
  "@workbench/tools-last30days/core:heartbeat_format_brief_title";

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
