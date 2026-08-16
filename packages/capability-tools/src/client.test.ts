import { expect, test } from "bun:test";

import {
  addCapability,
  CapabilityOutOfInventoryError,
  fetchCapabilityInventory,
  type CapabilityToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): CapabilityToolClientConfig {
  return {
    hubCapabilitiesUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    definitionId: "def_1",
    fetchImpl,
  };
}

test("addCapability posts to the definition's workflow-run capabilities endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        toolPackagePins: [{ name: "@corbits/github-tools" }],
        skills: [],
      }),
    );
  }) as unknown as typeof fetch;

  const result = await addCapability(testConfig(fetchImpl), {
    kind: "toolPackage",
    name: "@corbits/github-tools",
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-capabilities/def_1/capabilities",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(seenBody).toEqual({
    kind: "toolPackage",
    name: "@corbits/github-tools",
  });
  expect(result.toolPackagePins).toEqual([{ name: "@corbits/github-tools" }]);
});

test("addCapability throws CapabilityOutOfInventoryError on the route's fail-closed 400", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "bad_request",
          message:
            '"@corbits/nonexistent" for "toolPackage" was never offered in this workbench\'s inventory',
        },
      }),
      { status: 400 },
    )) as unknown as typeof fetch;

  await expect(
    addCapability(testConfig(fetchImpl), {
      kind: "toolPackage",
      name: "@corbits/nonexistent",
    }),
  ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
});

test("addCapability throws an honest error on a non-400 HTTP failure, never fabricating a result", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(
    addCapability(testConfig(fetchImpl), {
      kind: "skill",
      name: "granola-notes",
    }),
  ).rejects.toThrow(/500/);
});

test("addCapability throws on a response that doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ nonsense: true }),
    )) as unknown as typeof fetch;

  await expect(
    addCapability(testConfig(fetchImpl), {
      kind: "skill",
      name: "granola-notes",
    }),
  ).rejects.toThrow(/expected shape/);
});

test("fetchCapabilityInventory flattens the inventory to plain name arrays", async () => {
  const fetchImpl = (async (url: string | URL) => {
    expect(String(url)).toBe(
      "https://hub.example.com/api/workflow-capabilities/inventory",
    );
    return new Response(
      JSON.stringify({
        toolPackages: [{ name: "@corbits/memory-tools" }],
        skills: [{ name: "granola-notes" }],
        models: [{ canonicalName: "anthropic/claude-sonnet-5" }],
      }),
    );
  }) as unknown as typeof fetch;

  const inventory = await fetchCapabilityInventory(testConfig(fetchImpl));
  expect(inventory).toEqual({
    toolPackages: ["@corbits/memory-tools"],
    skills: ["granola-notes"],
    models: ["anthropic/claude-sonnet-5"],
  });
});

test("fetchCapabilityInventory throws an honest error when the hub is unreachable", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;

  await expect(fetchCapabilityInventory(testConfig(fetchImpl))).rejects.toThrow(
    /connection refused/,
  );
});
