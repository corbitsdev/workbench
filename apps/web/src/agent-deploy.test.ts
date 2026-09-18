import { describe, expect, test } from "bun:test";

import {
  agentDeploySourceAssetName,
  agentSlugFromSourceAssetName,
  buildAgentDefinitionJson,
} from "./agent-deploy";

describe("buildAgentDefinitionJson", () => {
  test("the JSON projection agrees with the bundle input it is pushed alongside", () => {
    // pushAgentSource renders both from the same args, but nothing else
    // typechecks that they describe the same run — this pins that they do.
    const args = {
      slug: "research-buddy",
      systemPrompt: "You research things.",
      triggerAddress: "research-buddy@example.test",
      declaredSources: [{ provider: "anthropic", model: "claude-test" }],
    };
    const projection = buildAgentDefinitionJson(args) as {
      id: string;
      triggers: readonly { to: string }[];
      steps: Record<string, { agent: { systemPrompt: string } }>;
    };
    const buildInput = {
      workflowId: args.slug,
      triggerAddress: args.triggerAddress,
      inferencePreferences: args.declaredSources,
      systemPrompt: args.systemPrompt,
    };

    expect(projection.id).toBe(buildInput.workflowId);
    expect(projection.triggers[0]?.to).toBe(buildInput.triggerAddress);
    expect(Object.values(projection.steps)[0]?.agent.systemPrompt).toBe(buildInput.systemPrompt);
  });
});

describe("agentSlugFromSourceAssetName", () => {
  test("recovers the slug agentDeploySourceAssetName wrapped", () => {
    expect(agentSlugFromSourceAssetName(agentDeploySourceAssetName("echo-bot"))).toBe("echo-bot");
  });

  test("is null for a name this pipeline didn't produce", () => {
    expect(agentSlugFromSourceAssetName("echo-bot")).toBeNull();
    expect(agentSlugFromSourceAssetName("agent-agent-echo-bot-source-source")).toBe(
      "agent-echo-bot-source",
    );
  });
});
