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

  // Whether a row from another tenant tree ever reaches this predicate is
  // the resolution layer's job (`SkillAssetStore.findByName` /
  // `SkillAccessStore.listForTenant`, both chain-bounded — see
  // registry.test.ts's "tenant inheritance" suite for that boundary
  // exercised end to end); once a row is inherited from an ancestor,
  // scope is the only remaining gate, which is what these cases cover.
  test("an inherited tenant-scoped skill is visible even though its row's tenant differs from the caller's", () => {
    expect(
      isSkillVisibleTo(row({ scope: "tenant", tenantId: "tenant_parent" }), {
        tenantId: "tenant_child",
        principalId: "principal_other",
      }),
    ).toBe(true);
  });

  test("an inherited private skill stays hidden from everyone but its creator", () => {
    const inherited = row({ scope: "private", tenantId: "tenant_parent" });
    expect(
      isSkillVisibleTo(inherited, {
        tenantId: "tenant_child",
        principalId: "principal_other",
      }),
    ).toBe(false);
    expect(
      isSkillVisibleTo(inherited, {
        tenantId: "tenant_child",
        principalId: "principal_author",
      }),
    ).toBe(true);
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

  test("the skill's own creator cannot administer it from a child tenant it was only inherited into", () => {
    const inherited = row({ scope: "tenant", tenantId: "tenant_parent" });
    expect(
      canAdministerSkill(inherited, {
        tenantId: "tenant_child",
        principalId: "principal_author",
      }),
    ).toBe(false);
  });
});
