// Registry behavior for the settings shell: sections resolve by id, and an
// unknown/empty id never crashes — it falls back to the first section, and
// an empty registry is its own distinct outcome.

import { describe, expect, test } from "bun:test";

import { resolveActiveSection } from "../src/shell";
import type { SettingsSection } from "../src/shell";

function section(id: string): SettingsSection {
  return { id, title: id, render: () => <div>{id}</div> } as SettingsSection;
}

describe("resolveActiveSection", () => {
  test("resolves the section matching the requested id", () => {
    const sections = [section("bench"), section("chat"), section("account")];
    expect(resolveActiveSection(sections, "chat")?.id).toBe("chat");
  });

  test("falls back to the first section when the id is unknown", () => {
    const sections = [section("bench"), section("chat")];
    expect(resolveActiveSection(sections, "does-not-exist")?.id).toBe("bench");
  });

  test("falls back to the first section when the id is null", () => {
    const sections = [section("bench"), section("chat")];
    expect(resolveActiveSection(sections, null)?.id).toBe("bench");
  });

  test("returns undefined, not a crash, for an empty registry", () => {
    expect(resolveActiveSection([], "anything")).toBeUndefined();
  });
});
