import { describe, expect, test } from "bun:test";

import { settingsSectionIdFromPath } from "./path-ids";

describe("settingsSectionIdFromPath", () => {
  test("returns null for the bare /settings path", () => {
    expect(settingsSectionIdFromPath("/settings")).toBeNull();
  });

  test("extracts the section id from /settings/:id", () => {
    expect(settingsSectionIdFromPath("/settings/people")).toBe("people");
  });

  test("decodes an encoded section id", () => {
    expect(settingsSectionIdFromPath("/settings/a%2Fb")).toBe("a/b");
  });

  test("returns null for an unrelated path", () => {
    expect(settingsSectionIdFromPath("/agents/agent_1")).toBeNull();
  });
});
