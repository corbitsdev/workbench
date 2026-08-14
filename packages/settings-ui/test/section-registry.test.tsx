// The Personal / Workspace registry is the single source of truth for both
// the settings stage and a host's own section nav (col2) — these tests
// pin its ordering and its tenancy gating so the two can never drift.

import { describe, expect, test } from "bun:test";
import { Bot } from "lucide-react";

import {
  insertWorkspaceSections,
  resolveSettingsSectionGroups,
} from "../src/section-registry";
import type { TenancyAccess } from "../src/access";
import type { SettingsSection } from "../src/shell";

const denied: TenancyAccess = {
  people: "denied",
  roles: "denied",
  grants: "denied",
  credentials: "denied",
};

const allowed: TenancyAccess = {
  people: "allowed",
  roles: "allowed",
  grants: "allowed",
  credentials: "allowed",
};

function ids(groups: ReturnType<typeof resolveSettingsSectionGroups>) {
  return groups.map((group) => ({
    id: group.id,
    sections: group.sections.map((section) => section.id),
  }));
}

describe("resolveSettingsSectionGroups", () => {
  test("Personal is always full; gated Workspace sections are absent, not disabled", () => {
    expect(ids(resolveSettingsSectionGroups(denied))).toEqual([
      { id: "personal", sections: ["agent", "chat", "account"] },
      { id: "workspace", sections: ["bench", "audit"] },
    ]);
  });

  test("an allowed gate adds its section in registry order", () => {
    expect(ids(resolveSettingsSectionGroups(allowed))).toEqual([
      { id: "personal", sections: ["agent", "chat", "account"] },
      {
        id: "workspace",
        sections: [
          "bench",
          "people",
          "roles",
          "grants",
          "connections",
          "audit",
        ],
      },
    ]);
  });

  test("a loading probe withholds its section the same as a denied one", () => {
    const loading: TenancyAccess = {
      people: "loading",
      roles: "denied",
      grants: "allowed",
      credentials: "denied",
    };
    expect(ids(resolveSettingsSectionGroups(loading))).toEqual([
      { id: "personal", sections: ["agent", "chat", "account"] },
      { id: "workspace", sections: ["bench", "grants", "audit"] },
    ]);
  });

  test("every section carries a leading icon for a host's own nav", () => {
    for (const group of resolveSettingsSectionGroups(allowed)) {
      for (const section of group.sections) {
        expect(section.icon).toBeDefined();
      }
    }
  });
});

describe("insertWorkspaceSections", () => {
  const extra: readonly SettingsSection[] = [
    { id: "agents", title: "Agents", icon: Bot, render: () => <div /> },
    { id: "skills", title: "Skills", icon: Bot, render: () => <div /> },
  ];

  test("splices host sections into Workspace right after bench", () => {
    const groups = insertWorkspaceSections(
      resolveSettingsSectionGroups(denied),
      extra,
    );
    expect(ids(groups)).toEqual([
      { id: "personal", sections: ["agent", "chat", "account"] },
      { id: "workspace", sections: ["bench", "agents", "skills", "audit"] },
    ]);
  });

  test("leaves Personal untouched", () => {
    const groups = insertWorkspaceSections(
      resolveSettingsSectionGroups(allowed),
      extra,
    );
    const personal = groups.find((group) => group.id === "personal");
    expect(personal?.sections.map((section) => section.id)).toEqual([
      "agent",
      "chat",
      "account",
    ]);
  });

  test("is a no-op when there is nothing to insert", () => {
    const base = resolveSettingsSectionGroups(denied);
    expect(insertWorkspaceSections(base, [])).toBe(base);
  });
});
