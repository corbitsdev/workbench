import { expect, test } from "bun:test";

import {
  createAgentDefinition,
  CreateAgentDefinitionError,
  listAgentDefinitions,
  messageAgent,
  type AgentDirectoryToolClientConfig,
} from "./client";

const TENANT_BASE = "https://hub.example.com/api/tenants/ten_1";

function testConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<AgentDirectoryToolClientConfig> = {},
): AgentDirectoryToolClientConfig {
  return {
    hubAgentDirectoryUrl: "https://hub.example.com",
    tenantId: "ten_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
    pushSourceTreeImpl: async () => "deadbeef",
    ...overrides,
  };
}

function jsonRoutes(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const raw = String(url);
    for (const [suffix, body] of Object.entries(routes)) {
      if (raw.endsWith(suffix)) {
        return typeof body === "function"
          ? (body as (init?: RequestInit) => Response)(init)
          : Response.json(body);
      }
    }
    throw new Error(`unexpected fetch: ${raw}`);
  }) as unknown as typeof fetch;
}

test("listAgentDefinitions reads workflow assets named agent-<slug>-source and derives each address", async () => {
  const fetchImpl = jsonRoutes({
    "/assets?kind=workflow&inherited=false": [
      { id: "asset_1", name: "agent-research-buddy-source", displayName: "Research Buddy" },
      { id: "asset_myra", name: "myra-source", displayName: "Myra" },
    ],
    "/tenants/ten_1": { domain: "acme.example" },
  });

  const definitions = await listAgentDefinitions(testConfig(fetchImpl));
  expect(definitions).toEqual([
    { id: "asset_1", name: "Research Buddy", address: "research-buddy@acme.example" },
  ]);
});

test("listAgentDefinitions reports honestly when the workbench has no agents", async () => {
  const fetchImpl = jsonRoutes({
    "/assets?kind=workflow&inherited=false": [],
    "/tenants/ten_1": { domain: "acme.example" },
  });
  expect(await listAgentDefinitions(testConfig(fetchImpl))).toEqual([]);
});

test("createAgentDefinition rejects an empty name without any network call", async () => {
  const fetchImpl = (async () => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  await expect(
    createAgentDefinition(testConfig(fetchImpl), { name: "  ", systemPrompt: "x" }),
  ).rejects.toBeInstanceOf(CreateAgentDefinitionError);
});

test("createAgentDefinition fails closed when no model provider is connected", async () => {
  const fetchImpl = jsonRoutes({
    "/tenants/ten_1": { domain: "acme.example" },
    "/models": [],
  });
  await expect(
    createAgentDefinition(testConfig(fetchImpl), {
      name: "Research Buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  ).rejects.toThrow(/connect a model provider/i);
});

test("createAgentDefinition ensures the source asset, pushes it, and deploys through the stock route", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const raw = String(url);
    seen.push(`${init?.method ?? "GET"} ${raw}`);
    if (raw.endsWith("/tenants/ten_1")) return Response.json({ domain: "acme.example" });
    if (raw.endsWith("/models")) {
      return Response.json([
        {
          canonicalName: "claude-sonnet-5",
          offerings: [{ offeringId: "off_1", priority: 0, plugin: "anthropic" }],
        },
      ]);
    }
    if (raw.endsWith("/assets") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "asset_1" }), { status: 201 });
    }
    if (raw.endsWith("/git-tokens") && init?.method === "POST") {
      return Response.json({ id: "tok_1", secret: "sec_1" });
    }
    if (raw.includes("/git-tokens/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (raw.endsWith("/workflows/deployments") && init?.method === "POST") {
      return Response.json({ id: "dep_1", definitionAssetId: "asset_1", status: "deploying" });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  }) as unknown as typeof fetch;

  const result = await createAgentDefinition(testConfig(fetchImpl), {
    name: "Research Buddy",
    systemPrompt: "You are a careful research assistant.",
  });

  expect(result).toEqual({
    id: "asset_1",
    name: "Research Buddy",
    address: "research-buddy@acme.example",
    deploymentId: "dep_1",
    modelNote: null,
  });
  expect(seen.some((s) => s === `POST ${TENANT_BASE}/workflows/deployments`)).toBe(true);
});

test("createAgentDefinition finds the existing asset on a 409 name conflict", async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const raw = String(url);
    if (raw.endsWith("/tenants/ten_1")) return Response.json({ domain: "acme.example" });
    if (raw.endsWith("/models")) {
      return Response.json([
        {
          canonicalName: "claude-sonnet-5",
          offerings: [{ offeringId: "off_1", priority: 0, plugin: "anthropic" }],
        },
      ]);
    }
    if (raw.endsWith("/assets") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: { code: "conflict", message: "exists" } }), {
        status: 409,
      });
    }
    if (raw.endsWith("/assets?kind=workflow&inherited=false")) {
      return Response.json([{ id: "asset_existing", name: "agent-research-buddy-source" }]);
    }
    if (raw.endsWith("/git-tokens") && init?.method === "POST") {
      return Response.json({ id: "tok_1", secret: "sec_1" });
    }
    if (raw.includes("/git-tokens/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (raw.endsWith("/workflows/deployments") && init?.method === "POST") {
      return Response.json({
        id: "dep_1",
        definitionAssetId: "asset_existing",
        status: "deploying",
      });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  }) as unknown as typeof fetch;

  const result = await createAgentDefinition(testConfig(fetchImpl), {
    name: "Research Buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(result.id).toBe("asset_existing");
});

test("createAgentDefinition notes a model substitution when the request names a model outside the catalog", async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const raw = String(url);
    if (raw.endsWith("/tenants/ten_1")) return Response.json({ domain: "acme.example" });
    if (raw.endsWith("/models")) {
      return Response.json([
        {
          canonicalName: "ollama/llama3",
          offerings: [{ offeringId: "off_1", priority: 0, plugin: "ollama" }],
        },
      ]);
    }
    if (raw.endsWith("/assets") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "asset_1" }), { status: 201 });
    }
    if (raw.endsWith("/git-tokens") && init?.method === "POST") {
      return Response.json({ id: "tok_1", secret: "sec_1" });
    }
    if (raw.includes("/git-tokens/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (raw.endsWith("/workflows/deployments") && init?.method === "POST") {
      return Response.json({ id: "dep_1", definitionAssetId: "asset_1", status: "deploying" });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  }) as unknown as typeof fetch;

  const result = await createAgentDefinition(testConfig(fetchImpl), {
    name: "Research Buddy",
    systemPrompt: "You are a careful research assistant.",
    model: "gpt-4o",
  });
  expect(result.modelNote).toMatch(/gpt-4o/);
  expect(result.modelNote).toMatch(/ollama\/llama3/);
});

test("messageAgent posts to the stock mailbox send route", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return Response.json({ messageId: "msg_1", uid: 1 });
  }) as unknown as typeof fetch;

  const result = await messageAgent(testConfig(fetchImpl), {
    address: "research-buddy@acme.example",
    message: "Please look into X.",
  });
  expect(seenUrl).toBe(`${TENANT_BASE}/mailbox/me/inbox/send`);
  expect(seenBody).toMatchObject({
    to: ["research-buddy@acme.example"],
    body: "Please look into X.",
  });
  expect(result.messageId).toBe("msg_1");
});
