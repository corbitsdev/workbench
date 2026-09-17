import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { SKILLS_LIST_TOOL, SKILLS_LOAD_TOOL, SKILLS_SEARCH_TOOL, skillsTools } from "./tool";
import type { WorkflowSkillsToolEnv } from "./tool";

function testEnv(): WorkflowSkillsToolEnv {
  return {
    hubSkillsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowSkillsToolEnv;
}

function callFor(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares skills_list, skills_search, and skills_load", () => {
  const bundle = skillsTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    SKILLS_LIST_TOOL,
    SKILLS_SEARCH_TOOL,
    SKILLS_LOAD_TOOL,
  ]);
});

test("requires the sanctioned workflow-skills env keys, not a per-user credential", () => {
  expect(skillsTools.requires).toEqual(["hubSkillsUrl", "sidecarToken", "address"]);
});

test("no tool's input schema accepts a tenant or principal argument", () => {
  const bundle = skillsTools(testEnv());
  for (const definition of bundle.definitions) {
    const properties = (
      definition as unknown as {
        inputSchema?: { properties?: Record<string, unknown> };
      }
    ).inputSchema?.properties;
    expect(properties?.["tenantId"]).toBeUndefined();
    expect(properties?.["principalId"]).toBeUndefined();
  }
});

// CL-8086: the registry HTTP surface this client used to call was
// deleted, and no stock Interchange route yet serves skill content, so
// every call fails closed rather than reaching a live registry.
test("skills_list surfaces the missing stock route as an error, never an empty list", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor(SKILLS_LIST_TOOL),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("no stock Interchange HTTP route");
});

test("skills_search requires a query", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor(SKILLS_SEARCH_TOOL),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("requires a query");
});

test("skills_load surfaces the missing stock route as an error rather than inventing one", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor(SKILLS_LOAD_TOOL, { name: "triage" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("no stock Interchange HTTP route");
});

test("skills_load requires a name", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor(SKILLS_LOAD_TOOL),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("requires a skill name");
});

test("load_skill is no longer a recognized tool name", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor("load_skill", { name: "triage" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("unknown tool");
});

test("an unknown tool name is an error result, not a throw", async () => {
  const result = await skillsTools(testEnv()).run(
    callFor("skills_delete"),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("unknown tool");
});
