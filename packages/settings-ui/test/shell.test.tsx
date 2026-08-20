// Registry behavior for the settings shell: sections resolve by id, and an
// unknown/empty id never crashes — it falls back to the first section, and
// an empty registry is its own distinct outcome.

import { describe, expect, test } from "bun:test";
import { Bell } from "@corbits/icons";

import { flattenSettingsSections, resolveActiveSection } from "../src/shell";
import type { SettingsSection, SettingsSectionGroup } from "../src/shell";

function section(id: string): SettingsSection {
  return { id, title: id, icon: Bell, render: () => <div>{id}</div> };
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

  // A mismatched id (unknown, or gate-denied and so absent from `sections`)
  // resolves to the exact first-section object — the fixed behavior a host
  // relies on to correct its own URL (see apps/web's SettingsRoute) instead
  // of silently rendering the fallback under a URL its own nav disagrees
  // with.
  test("a mismatched id resolves to the first section itself, for a caller to redirect to", () => {
    const sections = [section("agent"), section("bench")];
    const resolved = resolveActiveSection(sections, "people");
    expect(resolved).toBe(sections[0]);
  });
});

describe("flattenSettingsSections", () => {
  test("walks Personal then Workspace in order", () => {
    const groups: SettingsSectionGroup[] = [
      {
        id: "personal",
        label: "Personal Settings",
        sections: [section("agent"), section("account")],
      },
      {
        id: "workspace",
        label: "Shared Settings",
        sections: [section("bench"), section("audit")],
      },
    ];
    expect(flattenSettingsSections(groups).map((s) => s.id)).toEqual([
      "agent",
      "account",
      "bench",
      "audit",
    ]);
  });
});
