import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { HUB_RPC_ENV_KEY } from "@workbench/tool-credentials";
import { skills } from "./interchange-tools";

const ctx = {
  baseURL: "https://hub.test",
  token: "sidecar-tok",
  tenantId: "t1",
  agentId: "a1",
  principalId: "p1",
  sessionId: "s1",
};

const env = { [HUB_RPC_ENV_KEY]: ctx } as unknown as BaseEnv;

describe("tools-skills interchange.tools entry", () => {
  test("exports a namespaced hub-backed AnnotatedToolFactory", () => {
    expect(typeof skills).toBe("function");
    expect(skills.id).toBe("@workbench/tools-skills/skills");
    expect(skills.requires).toEqual([HUB_RPC_ENV_KEY]);
  });

  test("the bundle exposes list_skills, search_skills, load_skill", () => {
    const names = skills(env)
      .definitions.map((d) => d.name)
      .sort();
    expect(names).toEqual(["list_skills", "load_skill", "search_skills"]);
  });
});
