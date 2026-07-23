import { describe, expect, it, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { HUB_RPC_ENV_KEY, toolCredentialEnvKey } from "./index";
import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
  writeToolNamesFromEntries,
} from "./factory";

const definition = {
  name: "demo_search",
  description: "demo",
  inputSchema: { type: "object" as const, properties: {} },
};

const factory = defineCredentialedToolPackage({
  id: "@workbench/tools-demo/demo",
  provider: "demo",
  entries: {
    demo_search: {
      sideEffect: "read",
      createTools: (cred) => [
        {
          kind: "string",
          definition,
          handler: async () => `key=${cred.apiKey}`,
        },
      ],
    },
  },
});

describe("defineCredentialedToolPackage", () => {
  test("declares the provider credential as a requirement", () => {
    expect(factory.id).toBe("@workbench/tools-demo/demo");
    expect(factory.requires).toEqual([toolCredentialEnvKey("demo")]);
  });

  test("builds tools bound to the injected credential", async () => {
    const env = {
      [toolCredentialEnvKey("demo")]: { apiKey: "k1", baseURL: "https://api" },
    } as unknown as BaseEnv;
    const bundle = factory(env);
    expect(bundle.definitions.map((d) => d.name)).toEqual(["demo_search"]);
    const result = await bundle.run(
      { id: "c1", name: "demo_search", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.content).toBe("key=k1");
  });

  test("throws at construction when the credential was not injected", () => {
    expect(() => factory({} as BaseEnv)).toThrow(/demo/);
  });

  test("writeToolNamesFromEntries lists only write-classified tools", () => {
    expect(
      writeToolNamesFromEntries({
        a_read: { sideEffect: "read" },
        b_write: { sideEffect: "write" },
        c_write: { sideEffect: "write" },
      }),
    ).toEqual(["b_write", "c_write"]);
  });
});

// The rail's structured contract: a kind-full hub tool's object content must
// arrive as an OBJECT on the ToolResult, never as JSON text — step selectors
// (e.g. heartbeat notify-prep merging persist.output.content) consume it
// directly and a string operand fails the merge.
it("passes structured hub-tool results through as objects", async () => {
  const factory = defineHubBackedToolPackage({
    id: "@workbench/tools-test/structured",
    definitions: [
      { name: "structured_tool", description: "t", inputSchema: { type: "object", properties: {} } },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      result: JSON.stringify({ artifactId: "art-1", version: 2 }),
      structuredResult: { artifactId: "art-1", version: 2 },
      isError: false,
    })) as unknown as typeof fetch;
  try {
    const bundle = factory({
      [HUB_RPC_ENV_KEY]: {
        baseURL: "https://hub.test",
        token: "t",
        tenantId: "t1",
        agentId: "a1",
        principalId: "p1",
        sessionId: "s1",
      },
    } as never);
    const result = await bundle.run(
      { id: "c1", name: "structured_tool", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ artifactId: "art-1", version: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
