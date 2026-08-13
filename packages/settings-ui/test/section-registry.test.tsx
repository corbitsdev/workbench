// The Personal / Workspace registry is the single source of truth for both
// the settings stage and a host's own section nav (col2) — these tests
// pin its ordering and its tenancy gating so the two can never drift.

import { describe, expect, test } from "bun:test";

import { resolveSettingsSectionGroups } from "../src/section-registry";
import type { TenancyAccess } from "../src/access";

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
          "credentials",
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
