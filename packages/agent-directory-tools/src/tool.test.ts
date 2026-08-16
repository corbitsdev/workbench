import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  agentDirectoryTools,
  CREATE_AGENT_TOOL,
  LIST_AGENTS_TOOL,
  type WorkflowAgentDirectoryEnv,
} from "./tool";

function testEnv(): WorkflowAgentDirectoryEnv {
  return {
    hubAgentDirectoryUrl: "https://hub.example.com",
    hubChatUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAgentDirectoryEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares exactly list_agents and create_agent", () => {
  const bundle = agentDirectoryTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LIST_AGENTS_TOOL,
    CREATE_AGENT_TOOL,
  ]);
});

test("requires the sanctioned env keys", () => {
  expect(agentDirectoryTools.requires).toEqual([
    "hubAgentDirectoryUrl",
    "hubChatUrl",
    "sidecarToken",
    "address",
  ]);
});

test('list_agents declares no approval; create_agent declares approval: "ask"', () => {
  expect(agentDirectoryTools.definitions).toEqual([
    { name: LIST_AGENTS_TOOL },
    { name: CREATE_AGENT_TOOL, approval: "ask" },
  ]);
});

test("create_agent's input schema requires name and systemPrompt only", () => {
  const bundle = agentDirectoryTools(testEnv());
  const definition = bundle.definitions[1] as unknown as {
    inputSchema: { required: string[] };
  };
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

test("an unknown tool name returns an honest error", async () => {
  const bundle = agentDirectoryTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});

test("list_agents reports the tenant's taskable agents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        definitions: [
          {
            id: "def_1",
            name: "Research Buddy",
            description: "Answers research questions",
          },
        ],
      }),
    )) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_AGENTS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Research Buddy");
    expect(result.content).toContain("Answers research questions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list_agents reports honestly when the workbench has no other agents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ definitions: [] }),
    )) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_AGENTS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/No other agents/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_agent creates then invites by default, in one call sequence", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    seenUrls.push(String(url));
    if (String(url).endsWith("/definitions")) {
      return new Response(
        JSON.stringify({
          id: "def_1",
          name: "Research Buddy",
          description: null,
          currentVersion: 1,
          status: "deployed",
          skills: [],
        }),
        { status: 201 },
      );
    }
    return new Response(
      JSON.stringify({
        address: "ins_1@acme.example",
        definitionId: "def_1",
        handle: "research-buddy",
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(CREATE_AGENT_TOOL, {
        name: "Research Buddy",
        systemPrompt: "You are a careful research assistant.",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Created "Research Buddy"/);
    expect(result.content).toMatch(/invited/);
    expect(seenUrls.some((url) => url.endsWith("/definitions"))).toBe(true);
    expect(seenUrls.some((url) => url.endsWith("/participants/invite"))).toBe(
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_agent with invite: false creates but never calls the invite route", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    seenUrls.push(String(url));
    return new Response(
      JSON.stringify({
        id: "def_1",
        name: "Research Buddy",
        description: null,
        currentVersion: 1,
        status: "deployed",
        skills: [],
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(CREATE_AGENT_TOOL, {
        name: "Research Buddy",
        systemPrompt: "You are a careful research assistant.",
        invite: false,
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Created "Research Buddy"/);
    expect(seenUrls.some((url) => url.endsWith("/participants/invite"))).toBe(
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_agent reports a create-succeeded/invite-failed half-failure honestly, never as a plain error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/definitions")) {
      return new Response(
        JSON.stringify({
          id: "def_1",
          name: "Research Buddy",
          description: null,
          currentVersion: 1,
          status: "deployed",
          skills: [],
        }),
        { status: 201 },
      );
    }
    return new Response(
      JSON.stringify({ error: { code: "not_found", message: "no channel" } }),
      { status: 404 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(CREATE_AGENT_TOOL, {
        name: "Research Buddy",
        systemPrompt: "You are a careful research assistant.",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Created "Research Buddy"/);
    expect(result.content).toMatch(/could not invite/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_agent maps modelPreference to the create route's model field", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: unknown;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/definitions")) {
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "def_1",
          name: "Research Buddy",
          description: null,
          currentVersion: 1,
          status: "deployed",
          skills: [],
        }),
        { status: 201 },
      );
    }
    return new Response(
      JSON.stringify({
        address: "ins_1@acme.example",
        definitionId: "def_1",
        handle: "research-buddy",
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    await bundle.run(
      callFor(CREATE_AGENT_TOOL, {
        name: "Research Buddy",
        systemPrompt: "You are a careful research assistant.",
        modelPreference: "anthropic/claude-sonnet-5",
      }),
      new AbortController().signal,
    );
    expect((seenBody as { model?: string }).model).toBe(
      "anthropic/claude-sonnet-5",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_agent surfaces the create route's own rejection honestly on failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "conflict", message: "already exists" },
      }),
      { status: 409 },
    )) as unknown as typeof fetch;
  try {
    const bundle = agentDirectoryTools(testEnv());
    const result = await bundle.run(
      callFor(CREATE_AGENT_TOOL, {
        name: "Research Buddy",
        systemPrompt: "You are a careful research assistant.",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/already exists/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
