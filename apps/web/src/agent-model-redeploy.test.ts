import { describe, expect, test } from "bun:test";

import {
  buildAgentRedeployInput,
  needsAgentRedeployForProviderChange,
} from "./agent-model-redeploy";
import type { Grant } from "./settings/tenancy-api";

function grant(id: string, resource: string, effect: Grant["effect"]): Grant {
  return {
    id,
    tenantId: "bench",
    principalId: "principal",
    resource,
    action: "invoke",
    effect,
    origin: "invoker",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("needsAgentRedeployForProviderChange", () => {
  test("stays quiet when the agent already declares the current offering", () => {
    expect(
      needsAgentRedeployForProviderChange(
        [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      ),
    ).toBe(false);
  });

  test("flags a provider change", () => {
    expect(
      needsAgentRedeployForProviderChange(
        [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        [{ provider: "openai", model: "gpt-5" }],
      ),
    ).toBe(true);
  });

  test("flags a model change on the same provider", () => {
    expect(
      needsAgentRedeployForProviderChange(
        [{ provider: "openai", model: "gpt-5" }],
        [{ provider: "openai", model: "gpt-5.5" }],
      ),
    ).toBe(true);
  });

  test("flags a changed fallback chain", () => {
    expect(
      needsAgentRedeployForProviderChange(
        [
          { provider: "anthropic", model: "claude-sonnet-4-5" },
          { provider: "openai", model: "gpt-5" },
        ],
        [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      ),
    ).toBe(true);
  });

  test("stays quiet when no provider is connected yet", () => {
    expect(
      needsAgentRedeployForProviderChange(
        [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        null,
      ),
    ).toBe(false);
  });
});

describe("buildAgentRedeployInput", () => {
  test("preserves the agent's config and marks a redeploy", () => {
    expect(
      buildAgentRedeployInput({
        name: "Research Buddy",
        slug: "research-buddy",
        systemPrompt: "You are helpful.",
        mcpHandles: ["exa"],
        toolGrants: [],
      }),
    ).toEqual({
      name: "Research Buddy",
      slug: "research-buddy",
      systemPrompt: "You are helpful.",
      mcpHandles: ["exa"],
      toolEffects: [],
      redeploy: true,
    });
  });

  test("carries allow and deny while dropping ask-gated permissions", () => {
    const input = buildAgentRedeployInput({
      name: "Research Buddy",
      slug: "research-buddy",
      systemPrompt: "You are helpful.",
      mcpHandles: [],
      toolGrants: [
        grant("allow-row", "tool:web_search", "allow"),
        grant("ask-row", "tool:send_mail", "ask"),
        grant("deny-row", "tool:delete_all", "deny"),
      ],
    });
    expect(input.toolEffects).toEqual([
      { resource: "tool:web_search", effect: "allow" },
      { resource: "tool:delete_all", effect: "deny" },
    ]);
    expect(input.redeploy).toBe(true);
  });
});
