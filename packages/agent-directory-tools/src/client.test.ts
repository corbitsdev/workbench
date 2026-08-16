import { expect, test } from "bun:test";

import {
  createAgentDefinition,
  CreateAgentDefinitionError,
  inviteParticipant,
  listAgentDefinitions,
  NoOwnChannelError,
  type AgentDirectoryToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): AgentDirectoryToolClientConfig {
  return {
    hubAgentDirectoryUrl: "https://hub.example.com",
    hubChatUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("createAgentDefinition posts to the workflow-agent-directory definitions endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
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
  }) as unknown as typeof fetch;

  const result = await createAgentDefinition(testConfig(fetchImpl), {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-agent-directory/definitions",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(seenBody).toEqual({
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(result.id).toBe("def_1");
});

test("createAgentDefinition throws CreateAgentDefinitionError on a 400", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ error: { code: "bad_request", message: "bad handle" } }),
      { status: 400 },
    )) as unknown as typeof fetch;

  await expect(
    createAgentDefinition(testConfig(fetchImpl), {
      name: "x",
      handle: "x",
      systemPrompt: "x",
    }),
  ).rejects.toBeInstanceOf(CreateAgentDefinitionError);
});

test("createAgentDefinition throws CreateAgentDefinitionError on a 409 conflict", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "conflict", message: "already exists" },
      }),
      { status: 409 },
    )) as unknown as typeof fetch;

  await expect(
    createAgentDefinition(testConfig(fetchImpl), {
      name: "x",
      handle: "x",
      systemPrompt: "x",
    }),
  ).rejects.toThrow(/already exists/);
});

test("createAgentDefinition throws an honest error on a non-4xx HTTP failure", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(
    createAgentDefinition(testConfig(fetchImpl), {
      name: "x",
      handle: "x",
      systemPrompt: "x",
    }),
  ).rejects.toThrow(/500/);
});

test("listAgentDefinitions returns the definitions array", async () => {
  const fetchImpl = (async (url: string | URL) => {
    expect(String(url)).toBe(
      "https://hub.example.com/api/workflow-agent-directory/definitions",
    );
    return new Response(
      JSON.stringify({
        definitions: [
          { id: "def_1", name: "Research Buddy", description: null },
        ],
      }),
    );
  }) as unknown as typeof fetch;

  const definitions = await listAgentDefinitions(testConfig(fetchImpl));
  expect(definitions).toEqual([
    { id: "def_1", name: "Research Buddy", description: null },
  ]);
});

test("inviteParticipant posts to the workflow-chat participants invite endpoint", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        address: "ins_1@acme.example",
        definitionId: "def_1",
        handle: "research-buddy",
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await inviteParticipant(testConfig(fetchImpl), "def_1");
  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-chat/participants/invite",
  );
  expect(seenBody).toEqual({ definitionId: "def_1" });
  expect(result.address).toBe("ins_1@acme.example");
});

test("inviteParticipant throws NoOwnChannelError on a 404", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "no channel found" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    inviteParticipant(testConfig(fetchImpl), "def_1"),
  ).rejects.toBeInstanceOf(NoOwnChannelError);
});
