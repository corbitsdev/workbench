import { describe, expect, test } from "bun:test";

import { buildMyraDefinitionJson, buildMyraDeployInput, MyraDeployError } from "./myra-deploy";
import { MYRA_SOURCE_CONFIG } from "./myra-source";

describe("buildMyraDefinitionJson", () => {
  test("declares the offering chain's sources so the probe approves them", () => {
    const definition = buildMyraDefinitionJson("assistant@ada.example", [
      { provider: "openai-compatible", model: "qwen2.5:7b" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]) as { steps: Record<string, { agent: { inference: { sources: unknown } } }> };

    expect(definition.steps["assistant"]?.agent.inference.sources).toEqual([
      { provider: "openai-compatible", model: "qwen2.5:7b" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });
});

describe("buildMyraDeployInput", () => {
  test("maps the pushed commit and the operator's offering pick to a source-tree deploy", () => {
    const input = buildMyraDeployInput({
      assetId: "ast_123",
      commitSha: "abc123",
      sourceOfferingIds: ["off_1", "off_2"],
      defaultSourceOfferingId: "off_2",
    });

    expect(input).toEqual({
      source: {
        kind: "asset",
        assetId: "ast_123",
        package: { format: "source", commitSha: "abc123" },
      },
      entry: MYRA_SOURCE_CONFIG.entryPath,
      sourceOfferingIds: ["off_1", "off_2"],
      defaultSourceOfferingId: "off_2",
    });
  });

  test("rejects an empty offering list", () => {
    expect(() =>
      buildMyraDeployInput({
        assetId: "ast_123",
        commitSha: "abc123",
        sourceOfferingIds: [],
        defaultSourceOfferingId: "off_1",
      }),
    ).toThrow(MyraDeployError);
  });

  test("rejects a default offering id absent from the offering list", () => {
    expect(() =>
      buildMyraDeployInput({
        assetId: "ast_123",
        commitSha: "abc123",
        sourceOfferingIds: ["off_1"],
        defaultSourceOfferingId: "off_2",
      }),
    ).toThrow(MyraDeployError);
  });
});
