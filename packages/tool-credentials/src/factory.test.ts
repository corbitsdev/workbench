import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { toolCredentialEnvKey } from "./index";
import {
  defineCredentialedToolPackage,
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
