import { describe, expect, test } from "bun:test";

import {
  settingsEntityIdFromPath,
  settingsSectionIdFromPath,
} from "./path-ids";

describe("settingsSectionIdFromPath", () => {
  test("returns null for the bare /settings path", () => {
    expect(settingsSectionIdFromPath("/settings")).toBeNull();
  });

  test("extracts the section id from /settings/:id", () => {
    expect(settingsSectionIdFromPath("/settings/people")).toBe("people");
  });

  test("extracts only the first segment when a sub-id follows", () => {
    expect(settingsSectionIdFromPath("/settings/agents/wfd_1")).toBe("agents");
  });

  test("decodes an encoded section id", () => {
    expect(settingsSectionIdFromPath("/settings/a%2Fb")).toBe("a/b");
  });

  test("returns null for an unrelated path", () => {
    expect(settingsSectionIdFromPath("/agents/agent_1")).toBeNull();
  });
});

describe("settingsEntityIdFromPath", () => {
  test("extracts the sub-id under a section", () => {
    expect(settingsEntityIdFromPath("/settings/agents/wfd_1", "agents")).toBe(
      "wfd_1",
    );
  });

  test("decodes an encoded sub-id", () => {
    expect(settingsEntityIdFromPath("/settings/skills/a%2Fb", "skills")).toBe(
      "a/b",
    );
  });

  test("returns null when the path has no sub-id", () => {
    expect(settingsEntityIdFromPath("/settings/agents", "agents")).toBeNull();
  });

  test("returns null for a different section", () => {
    expect(
      settingsEntityIdFromPath("/settings/skills/skill_1", "agents"),
    ).toBeNull();
  });
});
