import { describe, expect, test } from "bun:test";

import { listSkills, loadSkill, searchSkills } from "./client";

const CONFIG = {
  hubSkillsUrl: "https://hub.example",
  sidecarToken: "sidecar-token",
  runAddress: "run@runs.example",
};

// the workflow-skills HTTP surface these calls used to reach was
// deleted, and no stock Interchange route yet serves skill content. Every
// call fails closed with an explicit error rather than degrading to an
// empty registry.
describe("listSkills", () => {
  test("fails closed naming the missing stock route", () => {
    expect(listSkills(CONFIG)).rejects.toThrow(/no stock Interchange HTTP route/);
  });
});

describe("searchSkills", () => {
  test("fails closed naming the missing stock route", () => {
    expect(searchSkills(CONFIG, "issues")).rejects.toThrow(/no stock Interchange HTTP route/);
  });
});

describe("loadSkill", () => {
  test("fails closed naming the missing stock route", () => {
    expect(loadSkill(CONFIG, "triage")).rejects.toThrow(/no stock Interchange HTTP route/);
  });
});
