import { describe, expect, test } from "bun:test";

import {
  canAdministerSkill,
  isSkillVisibleTo,
  type SkillAccessRow,
} from "./access";

function row(overrides: Partial<SkillAccessRow> = {}): SkillAccessRow {
  return {
    assetId: "asset_1",
    tenantId: "tenant_1",
    skillName: "triage",
    creatorPrincipalId: "principal_author",
    scope: "private",
    ...overrides,
  };
}

describe("isSkillVisibleTo", () => {
  test("a private skill is visible to its author", () => {
    expect(
      isSkillVisibleTo(row(), {
        tenantId: "tenant_1",
        principalId: "principal_author",
      }),
    ).toBe(true);
  });

  test("a private skill is hidden from another principal in the same tenant", () => {
    expect(
      isSkillVisibleTo(row(), {
        tenantId: "tenant_1",
        principalId: "principal_other",
      }),
    ).toBe(false);
  });

  test("a tenant-scoped skill is visible to any principal in its tenant", () => {
    expect(
      isSkillVisibleTo(row({ scope: "tenant" }), {
        tenantId: "tenant_1",
        principalId: "principal_other",
      }),
    ).toBe(true);
  });

  test("a tenant-scoped skill is never visible across tenants", () => {
    expect(
      isSkillVisibleTo(row({ scope: "tenant" }), {
        tenantId: "tenant_2",
        principalId: "principal_author",
      }),
    ).toBe(false);
  });
});

describe("canAdministerSkill", () => {
  test("only the author may administer, even when the skill is tenant-scoped", () => {
    const shared = row({ scope: "tenant" });
    expect(
      canAdministerSkill(shared, {
        tenantId: "tenant_1",
        principalId: "principal_author",
      }),
    ).toBe(true);
    expect(
      canAdministerSkill(shared, {
        tenantId: "tenant_1",
        principalId: "principal_other",
      }),
    ).toBe(false);
  });
});
