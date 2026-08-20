import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  capabilityTools,
  REQUEST_CAPABILITY_TOOL,
  type WorkflowCapabilityEnv,
} from "./tool";

function testEnv(): WorkflowCapabilityEnv {
  return {
    hubCapabilitiesUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    definitionId: "def_1",
  } as unknown as WorkflowCapabilityEnv;
}

function callFor(args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name: REQUEST_CAPABILITY_TOOL, arguments: args };
}

test("declares exactly the request_capability tool", () => {
  const bundle = capabilityTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    REQUEST_CAPABILITY_TOOL,
  ]);
});

test("requires the sanctioned workflow-capability env keys, including the calling agent's own definitionId", () => {
  expect(capabilityTools.requires).toEqual([
    "hubCapabilitiesUrl",
    "sidecarToken",
    "address",
    "definitionId",
  ]);
});

test("declares approval: \"ask\" — Interchange's native per-invocation gate — so a human must approve before this bundle's run() ever executes", () => {
  expect(capabilityTools.definitions).toEqual([
    { name: REQUEST_CAPABILITY_TOOL, approval: "ask" },
  ]);
});

test("the tool's input schema requires kind, name, and why, and offers an optional title for the approval card", () => {
  const bundle = capabilityTools(testEnv());
  const definition = bundle.definitions[0] as unknown as {
    inputSchema: { required: string[]; properties: Record<string, unknown> };
  };
  expect(definition.inputSchema.required).toEqual(["kind", "name", "why"]);
  expect(definition.inputSchema.properties["title"]).toBeDefined();
});

test("the tool's description reads as a humane approval-card headline", () => {
  const bundle = capabilityTools(testEnv());
  const definition = bundle.definitions[0] as unknown as {
    description: string;
  };
  expect(definition.description).toMatch(/^add a capability/);
});

test("rejects a call missing a required field without calling out", async () => {
  const bundle = capabilityTools(testEnv());
  const result = await bundle.run(
    callFor({ kind: "tool-package", name: "@corbits/github-tools" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("rejects an unknown kind without calling out", async () => {
  const bundle = capabilityTools(testEnv());
  const result = await bundle.run(
    callFor({ kind: "database", name: "prod", why: "need it" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
});

test("on approval, calls the capabilities route with the calling agent's own definitionId and returns a plain success message", async () => {
  let seenUrl: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(
      JSON.stringify({
        toolPackagePins: [{ name: "@corbits/github-tools" }],
        skills: [],
      }),
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = capabilityTools(testEnv());
    const result = await bundle.run(
      callFor({
        kind: "tool-package",
        name: "@corbits/github-tools",
        why: "I need to open a pull request",
        title: "GitHub tools",
      }),
      new AbortController().signal,
    );
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-capabilities/def_1/capabilities",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(
      "Added @corbits/github-tools — I can use it from my next reply.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps a model request's name to canonicalName in the request body", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ toolPackagePins: [], skills: [] }));
  }) as unknown as typeof fetch;
  try {
    const bundle = capabilityTools(testEnv());
    await bundle.run(
      callFor({
        kind: "model",
        name: "anthropic/claude-sonnet-5",
        why: "faster replies",
      }),
      new AbortController().signal,
    );
    expect(seenBody).toEqual({
      kind: "model",
      canonicalName: "anthropic/claude-sonnet-5",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an out-of-inventory request reports what's actually available, never a fabricated success", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (url: string | URL) => {
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "out of inventory" },
        }),
        { status: 400 },
      );
    }
    expect(String(url)).toBe(
      "https://hub.example.com/api/workflow-capabilities/inventory",
    );
    return new Response(
      JSON.stringify({
        toolPackages: [{ name: "@corbits/memory-tools" }],
        skills: [],
        models: [],
      }),
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = capabilityTools(testEnv());
    const result = await bundle.run(
      callFor({
        kind: "tool-package",
        name: "@corbits/nonexistent",
        why: "I want it",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/isn't available/);
    expect(result.content).toMatch(/@corbits\/memory-tools/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the route's own message if the inventory itself can't be fetched after an out-of-inventory rejection", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "nothing named that" },
        }),
        { status: 400 },
      );
    }
    throw new Error("hub unreachable");
  }) as unknown as typeof fetch;
  try {
    const bundle = capabilityTools(testEnv());
    const result = await bundle.run(
      callFor({
        kind: "skill",
        name: "nonexistent-skill",
        why: "I want it",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("nothing named that");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an honest error result on an unreachable hub, never fabricating success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
  try {
    const bundle = capabilityTools(testEnv());
    const result = await bundle.run(
      callFor({ kind: "tool-package", name: "@corbits/x", why: "why" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown tool name returns an honest error, never a silent no-op", async () => {
  const bundle = capabilityTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
