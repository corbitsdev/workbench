import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  skillsTools,
  CREATE_SKILL_TOOL,
  LIST_SKILLS_TOOL,
  PIN_SKILL_TOOL,
  READ_SKILL_TOOL,
  UPDATE_SKILL_TOOL,
  type WorkflowSkillsWriteEnv,
} from "./tool";

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

async function withFetch<T>(
  impl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("declares exactly the five skills tools", () => {
  const bundle = skillsTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LIST_SKILLS_TOOL,
    READ_SKILL_TOOL,
    CREATE_SKILL_TOOL,
    UPDATE_SKILL_TOOL,
    PIN_SKILL_TOOL,
  ]);
});

test("requires the sanctioned workflow-skills-write env keys", () => {
  expect(skillsTools.requires).toEqual([
    "hubSkillsUrl",
    "hubAgentDirectoryUrl",
    "sidecarToken",
    "address",
  ]);
});

test('the two reads carry no approval gate; the three writes are all approval: "ask"', () => {
  expect(skillsTools.definitions).toEqual([
    { name: LIST_SKILLS_TOOL },
    { name: READ_SKILL_TOOL },
    { name: CREATE_SKILL_TOOL, approval: "ask" },
    { name: UPDATE_SKILL_TOOL, approval: "ask" },
    { name: PIN_SKILL_TOOL, approval: "ask" },
  ]);
});

test("read_skill returns the skill's full body", async () => {
  const bundle = skillsTools(testEnv());
  const result = await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          data: {
            name: "triage",
            description: "Sorts inbound issues.",
            body: "## Steps\nAlways label severity first.",
          },
        }),
      )) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(READ_SKILL_TOOL, { name: "triage" }),
        new AbortController().signal,
      ),
  );
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("Always label severity first.");
});

test("read_skill rejects a call missing the name without calling out", async () => {
  const bundle = skillsTools(testEnv());
  const result = await bundle.run(
    callFor(READ_SKILL_TOOL, {}),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("read_skill surfaces a 404 as an honest tool error", async () => {
  const bundle = skillsTools(testEnv());
  const result = await withFetch(
    (async () =>
      new Response("", {
        status: 404,
        statusText: "Not Found",
      })) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(READ_SKILL_TOOL, { name: "ghost" }),
        new AbortController().signal,
      ),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/404/);
});

test("list_skills reports each skill's name and description", async () => {
  const bundle = skillsTools(testEnv());
  const result = await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          data: [{ name: "triage", description: "Sorts inbound issues." }],
        }),
      )) as unknown as typeof fetch,
    () =>
      bundle.run(callFor(LIST_SKILLS_TOOL, {}), new AbortController().signal),
  );
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("triage: Sorts inbound issues.");
});

test("list_skills reports plainly when the workbench has no skills yet", async () => {
  const bundle = skillsTools(testEnv());
  const result = await withFetch(
    (async () =>
      new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch,
    () =>
      bundle.run(callFor(LIST_SKILLS_TOOL, {}), new AbortController().signal),
  );
  expect(result.isError).toBeFalsy();
  expect(result.content).toMatch(/no skills/i);
});

test("create_skill rejects a call missing a required field without calling out", async () => {
  const bundle = skillsTools(testEnv());
  const result = await bundle.run(
    callFor(CREATE_SKILL_TOOL, { name: "triage", body: "b" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("create_skill posts the exact input and reports the created skill's name", async () => {
  const bundle = skillsTools(testEnv());
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const result = await withFetch(
    (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          data: {
            assetId: "asset_1",
            name: "triage",
            description: "Sorts inbound issues.",
            scope: "tenant",
            creatorPrincipalId: "prn_1",
            updatedAtIso: "2026-01-01T00:00:00.000Z",
          },
        }),
      );
    }) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(CREATE_SKILL_TOOL, {
          name: "triage",
          description: "Sorts inbound issues.",
          body: "Read the report.",
        }),
        new AbortController().signal,
      ),
  );
  expect(seenUrl).toBe("https://hub.example.com/api/workflow-skills/create");
  expect(seenBody).toEqual({
    name: "triage",
    description: "Sorts inbound issues.",
    body: "Read the report.",
  });
  expect(result.isError).toBeFalsy();
  expect(result.content).toBe('Created the "triage" skill.');
});

test("update_skill omits description from the request body when not supplied", async () => {
  const bundle = skillsTools(testEnv());
  let seenBody: unknown;
  const result = await withFetch(
    (async (_url: string | URL, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          data: {
            assetId: "asset_1",
            name: "triage",
            description: "Sorts inbound issues.",
            scope: "tenant",
            creatorPrincipalId: "prn_1",
            updatedAtIso: "2026-01-02T00:00:00.000Z",
          },
        }),
      );
    }) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(UPDATE_SKILL_TOOL, { name: "triage", body: "New body." }),
        new AbortController().signal,
      ),
  );
  expect(seenBody).toEqual({ name: "triage", body: "New body." });
  expect(result.isError).toBeFalsy();
  expect(result.content).toBe('Updated the "triage" skill.');
});

test("update_skill surfaces a 404 from the route as an honest tool error, never a fabricated success", async () => {
  const bundle = skillsTools(testEnv());
  const result = await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          error: { code: "not_found", message: "no such skill" },
        }),
        { status: 404 },
      )) as unknown as typeof fetch,
    () =>
      bundle.run(
        callFor(UPDATE_SKILL_TOOL, { name: "ghost", body: "b" }),
        new AbortController().signal,
      ),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/404/);
});

test("pin_skill reports the definition's full pinned-skill list after the pin", async () => {
  const bundle = skillsTools(testEnv());
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
  expect(result.content).toBe(
    'Pinned "research" — this definition now carries: triage, research.',
  );
});

test("pin_skill rejects a call missing skillName without calling out", async () => {
  const bundle = skillsTools(testEnv());
  const result = await bundle.run(
    callFor(PIN_SKILL_TOOL, { definitionId: "def_1" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});
