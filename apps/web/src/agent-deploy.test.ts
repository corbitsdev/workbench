import { MCP_TOOLS_PACKAGE } from "@corbits/myra/workflow-ids";
import { describe, expect, test } from "bun:test";

import {
  agentDeploySourceAssetName,
  agentSlugFromSourceAssetName,
  buildAgentDefinitionJson,
  buildScheduledRunBody,
  resolveMcpServerDeployments,
} from "./agent-deploy";
import type { McpServer } from "./mcp-servers";

describe("buildAgentDefinitionJson", () => {
  test("the JSON projection agrees with the bundle input it is pushed alongside", () => {
    // pushAgentSource renders both from the same args, but nothing else
    // typechecks that they describe the same run — this pins that they do.
    const args = {
      slug: "research-buddy",
      systemPrompt: "You research things.",
      triggerAddress: "research-buddy@example.test",
      declaredSources: [{ provider: "anthropic", model: "claude-test" }],
      hubCredentialId: "crd_000000000000000000000000000000ab",
      mcpServers: [],
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
      hubCredentialId: args.hubCredentialId,
    };

    expect(projection.id).toBe(buildInput.workflowId);
    expect(projection.triggers[0]?.to).toBe(buildInput.triggerAddress);
    expect(Object.values(projection.steps)[0]?.agent.systemPrompt).toBe(buildInput.systemPrompt);
  });
});

describe("resolveMcpServerDeployments", () => {
  const linear: McpServer = {
    credentialId: "c-linear",
    providerId: "p-linear",
    handle: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "token",
    tools: [
      {
        name: "list_issues",
        description: "List issues",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: {},
        annotations: {},
      },
    ],
  };

  test("a chosen handle becomes a deployment of the catalog server", () => {
    const [deployment] = resolveMcpServerDeployments([linear], ["linear"]);
    expect(deployment?.handle).toBe("linear");
    expect(deployment?.credentialId).toBe("c-linear");
    // Ask-gated except the read-only-annotated tool.
    expect(deployment?.allowWithoutAsk).toEqual(["linear.list_issues"]);
  });

  test("an unknown handle fails closed instead of deploying short a server", () => {
    expect(() => resolveMcpServerDeployments([linear], ["asana"])).toThrow("asana");
  });

  test("bindings and use requirements land in the definition JSON", () => {
    const deployments = resolveMcpServerDeployments([linear], ["linear"]);
    const projection = buildAgentDefinitionJson({
      slug: "linear-buddy",
      systemPrompt: "You triage.",
      triggerAddress: "linear-buddy@example.test",
      declaredSources: [{ provider: "anthropic", model: "claude-test" }],
      hubCredentialId: "crd_000000000000000000000000000000ab",
      mcpServers: deployments,
    }) as {
      credentialBindings: readonly { package: string; handle: string }[];
      grantRequirements: readonly unknown[];
    };
    expect(
      projection.credentialBindings.some(
        (binding) => binding.package === MCP_TOOLS_PACKAGE && binding.handle === "linear",
      ),
    ).toBe(true);
    expect(JSON.stringify(projection.grantRequirements)).toContain("c-linear");
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
