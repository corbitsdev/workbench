import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import { scrapecreators } from "./interchange-tools";

const env = {
  [toolCredentialEnvKey("scrapecreators")]: {
    apiKey: "test-key",
    baseURL: "https://api.test",
  },
} as unknown as BaseEnv;

describe("@workbench/tools-scrapecreators interchange.tools entry", () => {
  test("declares the scrapecreators credential requirement", () => {
    expect(typeof scrapecreators).toBe("function");
    expect(scrapecreators.id).toBe(
      "@workbench/tools-scrapecreators/scrapecreators",
    );
    expect(scrapecreators.requires).toEqual([
      toolCredentialEnvKey("scrapecreators"),
    ]);
  });

  test("builds its tools against the injected credential", () => {
    const bundle = scrapecreators(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test("throws at construction when the credential is absent", () => {
    expect(() => scrapecreators({} as BaseEnv)).toThrow();
  });
});
