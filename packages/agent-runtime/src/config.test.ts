import { describe, expect, test } from "bun:test";

import { parseAgentRuntimeConfig, type AgentRuntimeConfig } from "./config";

const stepConfig: AgentRuntimeConfig = {
  workflowId: "wf_run_a",
  agentId: "run_a",
  triggerAddress: "run_a@bench.example",
  systemPrompt: "You are helpful.",
  inferencePreferences: [{ provider: "acme", model: "acme-1" }],
  toolPackagePins: [],
  credentialBindings: [],
  mode: { kind: "step" },
};

describe("parseAgentRuntimeConfig", () => {
  test("accepts a step-mode config", () => {
    expect(parseAgentRuntimeConfig(stepConfig)).toEqual(stepConfig);
  });

  test("accepts a section-mode config with its turn timeout", () => {
    const sectionConfig: AgentRuntimeConfig = {
      ...stepConfig,
      mode: { kind: "section", turnTimeoutMs: 60_000 },
    };
    expect(parseAgentRuntimeConfig(sectionConfig)).toEqual(sectionConfig);
  });

  test("rejects an empty inference chain rather than building a modelless agent", () => {
    expect(() =>
      parseAgentRuntimeConfig({ ...stepConfig, inferencePreferences: [] }),
    ).toThrow(/invalid agent-runtime config/);
  });

  test("rejects a section mode with no turn timeout", () => {
    expect(() =>
      parseAgentRuntimeConfig({ ...stepConfig, mode: { kind: "section" } }),
    ).toThrow(/invalid agent-runtime config/);
  });

  test("rejects an unknown mode", () => {
    expect(() =>
      parseAgentRuntimeConfig({ ...stepConfig, mode: { kind: "swarm" } }),
    ).toThrow(/invalid agent-runtime config/);
  });

  test("rejects an empty trigger address", () => {
    expect(() =>
      parseAgentRuntimeConfig({ ...stepConfig, triggerAddress: "" }),
    ).toThrow(/invalid agent-runtime config/);
  });
});
