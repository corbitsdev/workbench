import { describe, expect, it } from "bun:test";
import type { GrantRule } from "@intx/types/authz";
import type { HubDb } from "../db";
import {
  featureGrantAllowed,
  isFeatureEnabledForTenant,
  isFeatureEnabledForTenantCached,
  resetFeatureGrantCache,
} from "./feature-grants";

// Pins the feature-grant decision through the REAL @intx/authz engine.
// Features are deny-by-default: only an explicit member-role ALLOW on
// `feature:<name>`/`enable` opts a tenant in.
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
    resource: "feature:scheduler",
    action: "enable",
    effect: "allow",
    ...base,
    ...r,
  })) as GrantRule[];
}

describe("featureGrantAllowed", () => {
  it("is off by default with no grants", async () => {
    expect(await featureGrantAllowed([], "scheduler")).toBe(false);
  });

  it("is on when a member-role allow targets the feature", async () => {
    expect(await featureGrantAllowed(grants({}), "scheduler")).toBe(true);
  });

  it("does not enable a different feature", async () => {
    const g = grants({ resource: "feature:triage" });
    expect(await featureGrantAllowed(g, "scheduler")).toBe(false);
  });

  it("a more specific deny beats a wildcard allow", async () => {
    const g = grants(
      { resource: "feature:*", action: "enable", effect: "allow" },
      { resource: "feature:scheduler", action: "enable", effect: "deny" },
    );
    expect(await featureGrantAllowed(g, "scheduler")).toBe(false);
  });
});

// The DB resolver: member-role lookup + grant-row -> GrantRule mapping. Mocks
// db.query only (no Postgres), same shape as workflow-run-gate.test.ts.
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
            resource: "feature:scheduler",
            action: "enable",
            effect: "allow",
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

function failingDb(): HubDb {
  return {
    query: {
      role: {
        findMany: async () => {
          throw new Error("db unreachable");
        },
      },
      grant: { findMany: async () => [] },
    },
  } as unknown as HubDb;
}

describe("isFeatureEnabledForTenant", () => {
  it("is enabled when the env override is on, even with no grant", async () => {
    const db = fakeDb([], []);
    expect(await isFeatureEnabledForTenant(db, "tn", "scheduler", true)).toBe(
      true,
    );
  });

  it("is disabled when env is off and no grant exists", async () => {
    const db = fakeDb(["rol_member"], []);
    expect(await isFeatureEnabledForTenant(db, "tn", "scheduler", false)).toBe(
      false,
    );
  });

  it("is enabled when env is off but the tenant's member role grants it", async () => {
    const db = fakeDb(["rol_member"], [{}]);
    expect(await isFeatureEnabledForTenant(db, "tn", "scheduler", false)).toBe(
      true,
    );
  });

  it("fails closed (disabled) when the grant store errors, never throwing", async () => {
    const db = failingDb();
    expect(await isFeatureEnabledForTenant(db, "tn", "scheduler", false)).toBe(
      false,
    );
  });
});

describe("isFeatureEnabledForTenantCached", () => {
  it("serves a cached value within the TTL without re-querying", async () => {
    resetFeatureGrantCache();
    let calls = 0;
    const db = fakeDb(["rol_member"], [{}]);
    const originalFindMany = db.query.grant.findMany;
    db.query.grant.findMany = (async (...args: unknown[]) => {
      calls += 1;
      return originalFindMany(...(args as []));
    }) as typeof db.query.grant.findMany;

    let clock = 1_000;
    const now = () => clock;

    const first = await isFeatureEnabledForTenantCached(
      db,
      "tn",
      "scheduler",
      false,
      { ttlMs: 30_000, now },
    );
    clock += 1_000;
    const second = await isFeatureEnabledForTenantCached(
      db,
      "tn",
      "scheduler",
      false,
      { ttlMs: 30_000, now },
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(calls).toBe(1);
  });

  it("re-queries once the TTL has elapsed", async () => {
    resetFeatureGrantCache();
    let calls = 0;
    const db = fakeDb(["rol_member"], [{}]);
    const originalFindMany = db.query.grant.findMany;
    db.query.grant.findMany = (async (...args: unknown[]) => {
      calls += 1;
      return originalFindMany(...(args as []));
    }) as typeof db.query.grant.findMany;

    let clock = 1_000;
    const now = () => clock;

    await isFeatureEnabledForTenantCached(db, "tn", "scheduler", false, {
      ttlMs: 100,
      now,
    });
    clock += 200;
    await isFeatureEnabledForTenantCached(db, "tn", "scheduler", false, {
      ttlMs: 100,
      now,
    });

    expect(calls).toBe(2);
  });
});
