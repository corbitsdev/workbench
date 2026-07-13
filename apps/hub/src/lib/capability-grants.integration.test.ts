import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { createInMemoryGrantStore } from "@intx/authz";
import { createGrantStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/types/authz";
import { CAPABILITY_ACTION, capabilityResource } from "@workbench/shared";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  isCapabilityAllowedForPrincipal,
  isCapabilityDeniedForTenant,
  listOwnerCapabilityStates,
  setCapabilityGrant,
} from "./capability-grants";

// Real-Postgres (PGlite) exercise of the capability gate over actual `grant`
// rows and the native @intx/authz engine (CL-3356 #1). The gate is
// allow-by-default: a connectable provider is available unless the owner writes
// an explicit member-role deny.

const TENANT = "ten-cap";
const MEMBER_ROLE = "rol-member";
const PROVIDER = "linear";

let client: PGlite;
let db: HubDb;

async function grantRows(provider: string) {
  return client.query<{ effect: string }>(
    `select effect from "grant" where role_id = $1 and resource = $2 and action = 'use'`,
    [MEMBER_ROLE, capabilityResource(provider)],
  );
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM "grant";`);
  await client.exec(`DELETE FROM principal_role;`);
  await client.exec(`DELETE FROM role;`);
  await client.query(
    `insert into role (id, tenant_id, name, is_system) values ($1, $2, 'member', true)`,
    [MEMBER_ROLE, TENANT],
  );
});

describe("capability enablement lifecycle", () => {
  test("a provider is allowed by default (no grant row)", async () => {
    expect(await isCapabilityDeniedForTenant(db, [TENANT], PROVIDER)).toBe(
      false,
    );
    expect((await grantRows(PROVIDER)).rows).toEqual([]);
  });

  test("owner-disable writes a single deny that hides the capability", async () => {
    await setCapabilityGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      provider: PROVIDER,
      enabled: false,
    });
    expect((await grantRows(PROVIDER)).rows.map((r) => r.effect)).toEqual([
      "deny",
    ]);
    expect(await isCapabilityDeniedForTenant(db, [TENANT], PROVIDER)).toBe(
      true,
    );
  });

  test("re-enable replaces the deny with a single allow", async () => {
    await setCapabilityGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      provider: PROVIDER,
      enabled: false,
    });
    await setCapabilityGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      provider: PROVIDER,
      enabled: true,
    });
    expect((await grantRows(PROVIDER)).rows.map((r) => r.effect)).toEqual([
      "allow",
    ]);
    expect(await isCapabilityDeniedForTenant(db, [TENANT], PROVIDER)).toBe(
      false,
    );
  });

  test("toggling never leaves more than one row for a provider", async () => {
    for (const enabled of [true, false, true, false]) {
      await setCapabilityGrant(db, {
        tenantId: TENANT,
        roleId: MEMBER_ROLE,
        provider: PROVIDER,
        enabled,
      });
    }
    expect((await grantRows(PROVIDER)).rows.length).toBe(1);
  });

  test("a deny on one provider does not hide another", async () => {
    await setCapabilityGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      provider: "linear",
      enabled: false,
    });
    expect(await isCapabilityDeniedForTenant(db, [TENANT], "linear")).toBe(
      true,
    );
    expect(await isCapabilityDeniedForTenant(db, [TENANT], "attio")).toBe(
      false,
    );
  });
});

describe("isCapabilityAllowedForPrincipal (per-(principal,provider) authz)", () => {
  function denyGrant(principalId: string, provider: string): GrantRule {
    return {
      id: `g-${principalId}`,
      resource: capabilityResource(provider),
      action: CAPABILITY_ACTION,
      effect: "deny",
      origin: "system",
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId,
    };
  }

  test("allow-by-default for a principal with no matching grant", async () => {
    const store = createInMemoryGrantStore([]);
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, "prn-a", "linear"),
    ).toBe(true);
  });

  test("a per-principal deny blocks only that principal", async () => {
    const store = createInMemoryGrantStore([denyGrant("prn-a", "linear")]);
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, "prn-a", "linear"),
    ).toBe(false);
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, "prn-b", "linear"),
    ).toBe(true);
    // The deny is provider-specific.
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, "prn-a", "attio"),
    ).toBe(true);
  });
});

describe("per-principal gate over the REAL DB grant store (route path)", () => {
  // Exercises the exact store the me-connections / callback routes inject
  // (createGrantStore), over real principal_role + grant rows, proving a denied
  // member cannot while an allowed member can.
  const MEMBER_A = "prn-a";
  const MEMBER_B = "prn-b";

  async function assignMemberRole(principalId: string) {
    await client.query(
      `insert into principal_role (principal_id, role_id) values ($1, $2)`,
      [principalId, MEMBER_ROLE],
    );
  }

  test("a per-principal deny blocks that member; another member is unaffected", async () => {
    await assignMemberRole(MEMBER_A);
    await assignMemberRole(MEMBER_B);

    // A per-principal deny on A only — B holds only the (grant-free) member role.
    await client.query(
      `insert into "grant" (id, tenant_id, principal_id, resource, action, effect, origin)
       values ($1, $2, $3, $4, $5, 'deny', 'system')`,
      [
        generateId("grant"),
        TENANT,
        MEMBER_A,
        capabilityResource("linear"),
        CAPABILITY_ACTION,
      ],
    );

    const store = createGrantStore(db);
    // A cannot authorize/use the capability; B (allow-by-default) can.
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, MEMBER_A, "linear"),
    ).toBe(false);
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, MEMBER_B, "linear"),
    ).toBe(true);
    // The deny is capability-scoped: A keeps other providers.
    expect(
      await isCapabilityAllowedForPrincipal(store, TENANT, MEMBER_A, "attio"),
    ).toBe(true);
  });
});

describe("listOwnerCapabilityStates", () => {
  test("projects every connectable provider with its effective state", async () => {
    await setCapabilityGrant(db, {
      tenantId: TENANT,
      roleId: MEMBER_ROLE,
      provider: "attio",
      enabled: false,
    });
    const states = await listOwnerCapabilityStates(db, [TENANT]);
    const byProvider = new Map(states.map((s) => [s.provider, s.enabled]));
    expect(byProvider.get("linear")).toBe(true);
    expect(byProvider.get("attio")).toBe(false);
  });
});
