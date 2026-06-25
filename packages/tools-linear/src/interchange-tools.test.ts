import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import { linear } from "./interchange-tools";

const env = {
  [toolCredentialEnvKey("linear")]: {
    apiKey: "test-key",
    baseURL: "https://api.test",
  },
} as unknown as BaseEnv;

describe("@workbench/tools-linear interchange.tools entry", () => {
  test("declares the linear credential requirement", () => {
    expect(typeof linear).toBe("function");
    expect(linear.id).toBe("@workbench/tools-linear/linear");
    expect(linear.requires).toEqual([toolCredentialEnvKey("linear")]);
  });

  test("builds its tools against the injected credential", () => {
    const bundle = linear(env);
    expect(bundle.definitions.length).toBe(4);
  });

  test("throws at construction when the credential is absent", () => {
    expect(() => linear({} as BaseEnv)).toThrow();
  });
});
