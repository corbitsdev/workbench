import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import { bluesky } from "./interchange-tools";

const env = {
  [toolCredentialEnvKey("bluesky")]: {
    apiKey: "test-key",
    baseURL: "https://api.test",
  },
} as unknown as BaseEnv;

describe("@workbench/tools-bluesky interchange.tools entry", () => {
  test("declares the bluesky credential requirement", () => {
    expect(typeof bluesky).toBe("function");
    expect(bluesky.id).toBe("@workbench/tools-bluesky/bluesky");
    expect(bluesky.requires).toEqual([toolCredentialEnvKey("bluesky")]);
  });

  test("builds its tools against the injected credential", () => {
    const bundle = bluesky(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test("throws at construction when the credential is absent", () => {
    expect(() => bluesky({} as BaseEnv)).toThrow();
  });
});
