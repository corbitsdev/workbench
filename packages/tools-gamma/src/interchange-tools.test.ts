import { describe, expect, it } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import {
  HUB_RPC_ENV_KEY,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { gamma, gammaTemplates } from "./interchange-tools";

// The factory env only needs the keys each factory declares via `requires`;
// the BaseEnv core fields are not read at construction.
function envWith(extra: Record<string, unknown>): BaseEnv {
  return extra as unknown as BaseEnv;
}

describe("gammaTemplates (CL-2597)", () => {
  it("is a hub-backed factory carrying only gamma_list_templates", () => {
    expect(gammaTemplates.id).toBe("@workbench/tools-gamma/gamma-templates");
    expect(gammaTemplates.requires).toEqual([HUB_RPC_ENV_KEY]);

    const bundle = gammaTemplates(
      envWith({
        [HUB_RPC_ENV_KEY]: {
          baseURL: "https://hub.test",
          token: "tok",
          tenantId: "t1",
          agentId: "a1",
          principalId: "p1",
          sessionId: "s1",
        },
      }),
    );
    expect(bundle.definitions.map((d) => d.name)).toEqual([
      "gamma_list_templates",
    ]);
  });
});

describe("gamma", () => {
  it("does not carry gamma_list_templates — it lives on the gammaTemplates factory", () => {
    expect(gamma.id).toBe("@workbench/tools-gamma/gamma");

    const bundle = gamma(
      envWith({
        [toolCredentialEnvKey("gamma")]: {
          apiKey: "key",
          baseURL: "https://gamma.test",
        },
      }),
    );
    const names = bundle.definitions.map((d) => d.name);
    expect(names).not.toContain("gamma_list_templates");
    expect(names).toContain("gamma_create_from_template");
  });
});
