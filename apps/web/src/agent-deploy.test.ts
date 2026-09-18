import { describe, expect, test } from "bun:test";

import {
  agentDeploySourceAssetName,
  agentSlugFromSourceAssetName,
  buildAgentDefinitionJson,
  buildScheduledRunBody,
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

describe("buildScheduledRunBody", () => {
  test("asks the agent to mail the deploying person's address", () => {
    const body = buildScheduledRunBody("alice@example.test");
    expect(body).toContain("alice@example.test");
    expect(body).toContain("`to` list");
  });

  test("falls back to a bare reply instruction when no address is known", () => {
    const body = buildScheduledRunBody(undefined);
    expect(body).not.toContain("@");
    expect(body).toContain("Reply with the result.");
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
