import { expect, test } from "bun:test";

import {
  createSkill,
  listSkills,
  loadSkill,
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

// CL-8086: the workflow-skills HTTP surface these four calls used to
// reach was deleted, and no stock Interchange route yet serves skill
// content, so each fails closed with an explicit error instead of
// reaching a dead route.
const unreachableFetch = (() => {
  throw new Error("must not be called: no stock route exists to call");
}) as unknown as typeof fetch;

test("listSkills fails closed naming the missing stock route", async () => {
  await expect(listSkills(testConfig(unreachableFetch))).rejects.toThrow(
    /no stock Interchange HTTP route/,
  );
});

test("loadSkill fails closed naming the missing stock route", async () => {
  await expect(loadSkill(testConfig(unreachableFetch), "triage")).rejects.toThrow(
    /no stock Interchange HTTP route/,
  );
});

test("createSkill fails closed naming the missing stock route", async () => {
  await expect(
    createSkill(testConfig(unreachableFetch), {
      name: "triage",
      description: "d",
      body: "b",
    }),
  ).rejects.toThrow(/no stock Interchange HTTP route/);
});

test("updateSkill fails closed naming the missing stock route", async () => {
  await expect(
    updateSkill(testConfig(unreachableFetch), { name: "triage", body: "b" }),
  ).rejects.toThrow(/no stock Interchange HTTP route/);
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
    new Response(JSON.stringify({ nonsense: true }))) as unknown as typeof fetch;

  await expect(
    pinSkill(testConfig(fetchImpl), {
      definitionId: "def_1",
      skillName: "research",
    }),
  ).rejects.toThrow(/expected shape/);
});
