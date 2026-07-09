import { describe, expect, test } from "bun:test";
import { CATALOG_OFFERINGS } from "@workbench/catalog";
import { LLM_PROVIDER } from "@workbench/agents";
import { buildAbPresetWorkflow } from "./builder";
import { SPEED_PRESET } from "./presets";

// The opencode-zen `openai-compatible` gateway is the ONLY inference path every
// preset variant runs on (see the file header in presets.ts). A model id that
// the gateway itself rejects (a fully-dated Anthropic snapshot id) or a model
// with more than one catalog offering left unpinned (so resolution can land on
// a native provider the step never declared credentials for) both produce a
// runtime inference failure that a build/typecheck pass cannot catch — only
// reading the resolved step sources can.
describe("SPEED_PRESET gateway-served models", () => {
  test("declares no fully-dated Anthropic snapshot id", () => {
    for (const variant of SPEED_PRESET.variants) {
      expect(variant.model).not.toMatch(/-\d{8}$/);
    }
  });

  test("every variant model has an opencode-zen catalog offering", () => {
    for (const variant of SPEED_PRESET.variants) {
      const hasOpencodeZenOffering = CATALOG_OFFERINGS.some(
        (o) => o.model === variant.model && o.provider === "opencode-zen",
      );
      expect(hasOpencodeZenOffering).toBe(true);
    }
  });

  test("a variant whose model has more than one catalog offering pins the opencode-zen plugin", () => {
    for (const variant of SPEED_PRESET.variants) {
      const offeringCount = CATALOG_OFFERINGS.filter(
        (o) => o.model === variant.model,
      ).length;
      if (offeringCount > 1) {
        expect(variant.provider).toBe(LLM_PROVIDER);
      }
    }
  });

  test("every built exec step resolves to the openai-compatible plugin", () => {
    const built = buildAbPresetWorkflow(SPEED_PRESET);
    for (let i = 0; i < SPEED_PRESET.variants.length; i += 1) {
      const step = built.workflow.steps[`exec${i}`];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for exec${i}`);
      }
      expect(step.agent.inference.sources[0]?.provider).toBe(LLM_PROVIDER);
    }
  });
});
