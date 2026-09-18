import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  skillsManageTools,
  CREATE_SKILL_TOOL,
  LIST_SKILLS_TOOL,
  PIN_SKILL_TOOL,
  READ_SKILL_TOOL,
  UPDATE_SKILL_TOOL,
  type WorkflowSkillsWriteEnv,
} from "./manage-tools";

function testEnv(): WorkflowSkillsWriteEnv {
  return {
    hubSkillsUrl: "https://hub.example.com",
    hubAgentDirectoryUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowSkillsWriteEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("declares exactly the five skills tools", () => {
  const bundle = skillsManageTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LIST_SKILLS_TOOL,
    READ_SKILL_TOOL,
    CREATE_SKILL_TOOL,
    UPDATE_SKILL_TOOL,
    PIN_SKILL_TOOL,
  ]);
});

test("requires the sanctioned workflow-skills-write env keys", () => {
  expect(skillsManageTools.requires).toEqual([
    "hubSkillsUrl",
    "hubAgentDirectoryUrl",
    "sidecarToken",
    "address",
  ]);
});

test('the two reads and the two grant-free writes (create_skill, update_skill) carry no approval gate; pin_skill, which changes another agent\'s own behavior, keeps approval: "ask"', () => {
  expect(skillsManageTools.definitions).toEqual([
    { name: LIST_SKILLS_TOOL },
    { name: READ_SKILL_TOOL },
    { name: CREATE_SKILL_TOOL },
    { name: UPDATE_SKILL_TOOL },
    { name: PIN_SKILL_TOOL, approval: "ask" },
  ]);
});

test("read_skill rejects a call missing the name without calling out", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(callFor(READ_SKILL_TOOL, {}), new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

// the workflow-skills HTTP surface these tools used to call was
// deleted, and no stock Interchange route yet serves skill content, so
// each fails closed with an explicit error instead of a fabricated
// result.
test("read_skill surfaces the missing stock route as an honest tool error", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(
    callFor(READ_SKILL_TOOL, { name: "triage" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/no stock Interchange HTTP route/);
});

test("list_skills surfaces the missing stock route as an honest tool error, never an empty list", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(callFor(LIST_SKILLS_TOOL, {}), new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/no stock Interchange HTTP route/);
});

test("create_skill rejects a call missing a required field without calling out", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(
    callFor(CREATE_SKILL_TOOL, { name: "triage", body: "b" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("create_skill surfaces the missing stock route as an honest tool error, never a fabricated success", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(
    callFor(CREATE_SKILL_TOOL, {
      name: "triage",
      description: "Sorts inbound issues.",
      body: "Read the report.",
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/no stock Interchange HTTP route/);
});

test("update_skill surfaces the missing stock route as an honest tool error, never a fabricated success", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(
    callFor(UPDATE_SKILL_TOOL, { name: "triage", body: "New body." }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/no stock Interchange HTTP route/);
});

test("pin_skill reports the definition's full pinned-skill list after the pin", async () => {
  const bundle = skillsManageTools(testEnv());
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const result = await withFetch(
    (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ skills: ["triage", "research"] }));
    }) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(PIN_SKILL_TOOL, {
          definitionId: "def_1",
          skillName: "research",
        }),
        new AbortController().signal,
      ),
  );
  expect(seenUrl).toBe("https://hub.example.com/api/workflow-skill-pins/pin");
  expect(seenBody).toEqual({ definitionId: "def_1", skillName: "research" });
  expect(result.isError).toBeFalsy();
  expect(result.content).toBe('Pinned "research" — this definition now carries: triage, research.');
});

test("pin_skill rejects a call missing skillName without calling out", async () => {
  const bundle = skillsManageTools(testEnv());
  const result = await bundle.run(
    callFor(PIN_SKILL_TOOL, { definitionId: "def_1" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});
