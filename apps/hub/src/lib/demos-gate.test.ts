import { describe, expect, it } from "bun:test";
import type { GrantRule } from "@intx/types/authz";
import { DEMO_LINKS } from "@workbench/shared";
import { demosViewAllowed, resolveDemoLinks } from "./demos-gate";

// Pins the demos gate through the REAL @intx/authz engine. Demos are
// deny-by-default: only an explicit member-role ALLOW on `demos`/`view` opts in.
const base = {
  origin: "role" as const,
  conditions: null,
  expiresAt: null,
  roleId: "rol_member",
  principalId: null,
};

function grants(...rules: Partial<GrantRule>[]): GrantRule[] {
  return rules.map((r, i) => ({
    id: `grt_${i}`,
    resource: "demos",
    action: "view",
    effect: "allow",
    ...base,
    ...r,
  })) as GrantRule[];
}

describe("demosViewAllowed", () => {
  it("hides demos when the tenant has no member-role grants (default)", async () => {
    expect(await demosViewAllowed([])).toBe(false);
  });

  it("shows demos when a member-role allow targets demos/view", async () => {
    expect(await demosViewAllowed(grants({}))).toBe(true);
  });

  it("keeps demos hidden when a deny is more specific than the allow", async () => {
    const g = grants(
      { resource: "demos", action: "*", effect: "allow" },
      { resource: "demos", action: "view", effect: "deny" },
    );
    expect(await demosViewAllowed(g)).toBe(false);
  });

  it("ignores grants for an unrelated resource", async () => {
    const g = grants({ resource: "workflow:brief", action: "run" });
    expect(await demosViewAllowed(g)).toBe(false);
  });
});

describe("resolveDemoLinks", () => {
  it("returns no links when neither env nor grant enables demos", () => {
    expect(resolveDemoLinks(false, false)).toEqual([]);
  });

  it("returns the links when the env flag forces demos on", () => {
    expect(resolveDemoLinks(true, false)).toEqual(DEMO_LINKS);
  });

  it("returns the links when the org-wide grant enables demos", () => {
    expect(resolveDemoLinks(false, true)).toEqual(DEMO_LINKS);
  });
});
