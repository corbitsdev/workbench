import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  agentDirectoryTools,
  CREATE_AGENT_TOOL,
  LIST_AGENTS_TOOL,
  MESSAGE_AGENT_TOOL,
  type WorkflowAgentDirectoryEnv,
} from "./tool";

function testEnv(): WorkflowAgentDirectoryEnv {
  return {
    hubAgentDirectoryUrl: "https://hub.example.com",
    tenantId: "ten_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAgentDirectoryEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares list_agents, create_agent, and message_agent", () => {
  const bundle = agentDirectoryTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LIST_AGENTS_TOOL,
    CREATE_AGENT_TOOL,
    MESSAGE_AGENT_TOOL,
  ]);
});

test("requires the sanctioned env keys", () => {
  expect(agentDirectoryTools.requires).toEqual([
    "hubAgentDirectoryUrl",
    "tenantId",
    "sidecarToken",
    "address",
  ]);
});

test("none of the tools declare an approval key", () => {
  expect(agentDirectoryTools.definitions).toEqual([
    { name: LIST_AGENTS_TOOL },
    { name: CREATE_AGENT_TOOL },
    { name: MESSAGE_AGENT_TOOL },
  ]);
});

test("create_agent's modelPreference field tells the model to omit it rather than guess a name", () => {
  const bundle = agentDirectoryTools(testEnv());
  const definition = bundle.definitions[1] as unknown as {
    inputSchema: { properties: { modelPreference: { description: string } } };
  };
  const description = definition.inputSchema.properties.modelPreference.description;
  expect(description).toMatch(/omit/i);
  expect(description).toMatch(/do not (guess|invent)/i);
});

test("create_agent's input schema requires name and systemPrompt only", () => {
  const bundle = agentDirectoryTools(testEnv());
  const definition = bundle.definitions[1] as unknown as { inputSchema: { required: string[] } };
  expect(definition.inputSchema.required).toEqual(["name", "systemPrompt"]);
});

test("create_agent rejects a call missing a required field", async () => {
  const bundle = agentDirectoryTools(testEnv());
  const result = await bundle.run(
    callFor(CREATE_AGENT_TOOL, { name: "Research Buddy" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("message_agent rejects a call missing a required field", async () => {
  const bundle = agentDirectoryTools(testEnv());
  const result = await bundle.run(
    callFor(MESSAGE_AGENT_TOOL, { address: "a@b.example" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("an unknown tool name returns an honest error", async () => {
  const bundle = agentDirectoryTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});

test("list_agents reports the tenant's taskable agents by address", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const raw = String(url);
    if (raw.endsWith("/assets?kind=workflow&inherited=false")) {
      return Response.json([
        { id: "asset_1", name: "agent-research-buddy-source", displayName: "Research Buddy" },
      ]);
    }
    return Response.json({ domain: "acme.example" });
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(callFor(LIST_AGENTS_TOOL, {}), new AbortController().signal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Research Buddy");
    expect(result.content).toContain("research-buddy@acme.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list_agents reports honestly when the workbench has no other agents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/assets?kind=workflow&inherited=false")) return Response.json([]);
    return Response.json({ domain: "acme.example" });
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(callFor(LIST_AGENTS_TOOL, {}), new AbortController().signal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/No other agents/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_agent sends through the stock mailbox route", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl: string | undefined;
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return Response.json({ messageId: "msg_1", uid: 1 });
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(MESSAGE_AGENT_TOOL, { address: "research-buddy@acme.example", message: "hi" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Message sent/);
    expect(seenUrl).toContain("/mailbox/me/inbox/send");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("message_agent surfaces a send failure honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: "not_found", userMessage: "no such agent" } }), {
      status: 404,
    })) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(MESSAGE_AGENT_TOOL, { address: "ghost@acme.example", message: "hi" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no such agent/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
