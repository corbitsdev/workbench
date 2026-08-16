import { expect, test } from "bun:test";

import {
  createSkill,
  listSkills,
  pinSkill,
  updateSkill,
  type SkillsToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): SkillsToolClientConfig {
  return {
    hubSkillsUrl: "https://hub.example.com",
    hubAgentDirectoryUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("listSkills gets the workflow-skills index with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    return new Response(
      JSON.stringify({
        data: [{ name: "triage", description: "Sorts inbound issues." }],
      }),
    );
  }) as unknown as typeof fetch;

  const skills = await listSkills(testConfig(fetchImpl));

  expect(seenUrl).toBe("https://hub.example.com/api/workflow-skills/list");
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(skills).toEqual([
    { name: "triage", description: "Sorts inbound issues." },
  ]);
});

test("listSkills throws an honest error on a non-ok response", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(listSkills(testConfig(fetchImpl))).rejects.toThrow(/500/);
});

test("createSkill posts to /create and parses back the created summary", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
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
  }) as unknown as typeof fetch;

  const skill = await createSkill(testConfig(fetchImpl), {
    name: "triage",
    description: "Sorts inbound issues.",
    body: "Read the report.",
  });

  expect(seenUrl).toBe("https://hub.example.com/api/workflow-skills/create");
  expect(seenBody).toEqual({
    name: "triage",
    description: "Sorts inbound issues.",
    body: "Read the report.",
  });
  expect(skill.name).toBe("triage");
  expect(skill.scope).toBe("tenant");
});

test("createSkill throws on a non-ok response, never fabricating a summary", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "conflict", message: "already exists" },
      }),
      { status: 409 },
    )) as unknown as typeof fetch;

  await expect(
    createSkill(testConfig(fetchImpl), {
      name: "triage",
      description: "d",
      body: "b",
    }),
  ).rejects.toThrow(/409/);
});

test("updateSkill posts to /update, omitting description when not given", async () => {
  let seenBody: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
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
  }) as unknown as typeof fetch;

  const skill = await updateSkill(testConfig(fetchImpl), {
    name: "triage",
    body: "Read the report. Pick one label.",
  });

  expect(seenBody).toEqual({
    name: "triage",
    body: "Read the report. Pick one label.",
  });
  expect(skill.description).toBe("Sorts inbound issues.");
});

test("updateSkill throws a 404 as a plain error when the skill doesn't exist", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "no such skill" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    updateSkill(testConfig(fetchImpl), { name: "ghost", body: "b" }),
  ).rejects.toThrow(/404/);
});

test("pinSkill posts to the agent-directory workflow-skill-pins surface", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ skills: ["triage", "research"] }));
  }) as unknown as typeof fetch;

  const skills = await pinSkill(testConfig(fetchImpl), {
    definitionId: "def_1",
    skillName: "research",
  });

  expect(seenUrl).toBe("https://hub.example.com/api/workflow-skill-pins/pin");
  expect(seenBody).toEqual({ definitionId: "def_1", skillName: "research" });
  expect(skills).toEqual(["triage", "research"]);
});

test("pinSkill throws on a response that doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ nonsense: true }),
    )) as unknown as typeof fetch;

  await expect(
    pinSkill(testConfig(fetchImpl), {
      definitionId: "def_1",
      skillName: "research",
    }),
  ).rejects.toThrow(/expected shape/);
});
