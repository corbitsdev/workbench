import { describe, expect, test } from "bun:test";

import {
  AGENT_RUNTIME_CONFIG_ENV,
  encodeAgentRuntimeConfig,
  parseAgentRuntimeConfig,
  readAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "./config";

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

describe("readAgentRuntimeConfig", () => {
  test("round-trips an encoded config out of the environment", () => {
    const env = {
      [AGENT_RUNTIME_CONFIG_ENV]: encodeAgentRuntimeConfig(stepConfig),
    };
    expect(readAgentRuntimeConfig(env)).toEqual(stepConfig);
  });

  test("throws when the config variable is absent", () => {
    expect(() => readAgentRuntimeConfig({})).toThrow(
      new RegExp(AGENT_RUNTIME_CONFIG_ENV),
    );
  });

  test("throws when the config variable is not JSON", () => {
    expect(() =>
      readAgentRuntimeConfig({ [AGENT_RUNTIME_CONFIG_ENV]: "not json" }),
    ).toThrow(/valid JSON/);
  });

  test("throws when the encoded config does not parse as a config", () => {
    expect(() =>
      readAgentRuntimeConfig({
        [AGENT_RUNTIME_CONFIG_ENV]: JSON.stringify({ workflowId: "wf" }),
      }),
    ).toThrow(/invalid agent-runtime config/);
  });
});

describe("encodeAgentRuntimeConfig", () => {
  test("refuses to encode a config the child would reject", () => {
    expect(() =>
      encodeAgentRuntimeConfig({
        ...stepConfig,
        inferencePreferences: [],
      }),
    ).toThrow(/invalid agent-runtime config/);
  });
});
