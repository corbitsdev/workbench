import { describe, expect, it } from "bun:test";
import type { GrantRule } from "@intx/types/authz";
import type { HubDb } from "../db";
import {
  isWorkflowRunDeniedForTenant,
  workflowRunDenied,
} from "./workflow-run-gate";

// Pins the workflow run gate's decision through the REAL @intx/authz engine.
// The gate is allow-by-default: only an explicit member-role `deny` on the
// workflow-run resource blocks a run. These grants are the shape the owner area
// writes to disable a workflow.
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
    resource: "*",
    action: "run",
    effect: "deny",
    ...base,
    ...r,
  })) as GrantRule[];
}

describe("workflowRunDenied", () => {
  it("allows when the tenant has no member-role grants (default)", async () => {
    expect(await workflowRunDenied([], "brief-builder")).toBe(false);
  });

  it("denies when a member-role deny targets the exact kind", async () => {
    const g = grants({ resource: "workflow:brief-builder", action: "run" });
    expect(await workflowRunDenied(g, "brief-builder")).toBe(true);
  });

  it("denies via a workflow:* wildcard deny (disable all)", async () => {
    const g = grants({ resource: "workflow:*", action: "run" });
    expect(await workflowRunDenied(g, "brief-builder")).toBe(true);
  });

  it("does not deny a different kind", async () => {
    const g = grants({ resource: "workflow:seo-audit", action: "run" });
    expect(await workflowRunDenied(g, "brief-builder")).toBe(false);
  });

  it("does not deny when the deny is for a different action", async () => {
    const g = grants({ resource: "workflow:brief-builder", action: "create" });
    expect(await workflowRunDenied(g, "brief-builder")).toBe(false);
  });

  it("allows when only an allow grant is present (no deny)", async () => {
    const g = grants({
      resource: "workflow:brief-builder",
      action: "run",
      effect: "allow",
    });
    expect(await workflowRunDenied(g, "brief-builder")).toBe(false);
  });

  it("deny beats a co-located allow for the same kind", async () => {
    const g = grants(
      { resource: "workflow:brief-builder", action: "run", effect: "allow" },
      { resource: "workflow:brief-builder", action: "run", effect: "deny" },
    );
    expect(await workflowRunDenied(g, "brief-builder")).toBe(true);
  });
});

// The DB resolver: member-role lookup across the tenant chain, grant-row →
// GrantRule mapping, and ancestor pooling. Mocks db.query only (no Postgres).
function fakeDb(
  memberRoleIds: string[],
  grantRows: Partial<GrantRule>[],
): HubDb {
  return {
    query: {
      role: { findMany: async () => memberRoleIds.map((id) => ({ id })) },
      grant: {
        findMany: async () =>
          grantRows.map((r, i) => ({
            id: `grt_${i}`,
            resource: "workflow:*",
            action: "run",
            effect: "deny",
            origin: "role",
            conditions: null,
            expiresAt: null,
            roleId: "rol_member",
            principalId: null,
            tenantId: "tn",
            createdAt: null,
            updatedAt: null,
            ...r,
          })),
      },
    },
  } as unknown as HubDb;
}

describe("isWorkflowRunDeniedForTenant", () => {
  it("denies when the tenant's member role holds a deny for the kind", async () => {
    const db = fakeDb(
      ["rol_member"],
      [{ resource: "workflow:brief-builder", action: "run", effect: "deny" }],
    );
    expect(
      await isWorkflowRunDeniedForTenant(db, ["tn"], "brief-builder"),
    ).toBe(true);
  });

  it("allows when no member role exists in the chain", async () => {
    const db = fakeDb([], []);
    expect(
      await isWorkflowRunDeniedForTenant(db, ["tn"], "brief-builder"),
    ).toBe(false);
  });

  it("allows when the only deny targets a different kind", async () => {
    const db = fakeDb(
      ["rol_member"],
      [{ resource: "workflow:seo-audit", action: "run", effect: "deny" }],
    );
    expect(
      await isWorkflowRunDeniedForTenant(db, ["tn"], "brief-builder"),
    ).toBe(false);
  });

  it("honors a deny pooled from an ANCESTOR tenant's member role", async () => {
    // chain = [child, parent]; the deny is attached to the parent's member role.
    const db = fakeDb(
      ["rol_child_member", "rol_parent_member"],
      [
        {
          resource: "workflow:brief-builder",
          action: "run",
          effect: "deny",
          roleId: "rol_parent_member",
        },
      ],
    );
    expect(
      await isWorkflowRunDeniedForTenant(
        db,
        ["tn_child", "tn_parent"],
        "brief-builder",
      ),
    ).toBe(true);
  });

  it("maps jsonb conditions without throwing (null → GrantRule)", async () => {
    const db = fakeDb(
      ["rol_member"],
      [{ resource: "workflow:brief-builder", action: "run", effect: "deny" }],
    );
    // Would throw if the row→GrantRule mapping mishandled conditions/expiresAt.
    await expect(
      isWorkflowRunDeniedForTenant(db, ["tn"], "brief-builder"),
    ).resolves.toBe(true);
  });
});
