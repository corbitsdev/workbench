import { describe, expect, test } from "bun:test";

import type { HubPrincipal, StockHub } from "./needs-converge";
import { triggerFirstLoginProvisioning } from "./onboarding";

function hubWithPrimaryTenant(principals: readonly HubPrincipal[]): StockHub {
  const tenant = { id: "tnt_home", name: "Home", slug: "home", parentId: null };
  return {
    listMyPrincipals: async () => [
      {
        id: "prn_me",
        tenantId: tenant.id,
        kind: "user",
        status: "active",
        roles: [{ id: "rol_owner", name: "owner" }],
      },
    ],
    getTenant: async () => tenant,
    listPrincipals: async () => [...principals],
  } as unknown as StockHub;
}

const myra: HubPrincipal = {
  id: "prn_myra",
  tenantId: "tnt_home",
  kind: "workflow",
  refId: "wfl_myra",
  displayName: "Myra",
  status: "active",
  roles: [],
};

describe("triggerFirstLoginProvisioning", () => {
  test("an owned tenant without Myra still needs onboarding", async () => {
    const outcome = await triggerFirstLoginProvisioning(hubWithPrimaryTenant([]));
    expect(outcome).toEqual({ kind: "needs-onboarding" });
  });

  test("an owned tenant with Myra live is an existing member", async () => {
    const outcome = await triggerFirstLoginProvisioning(hubWithPrimaryTenant([myra]));
    expect(outcome).toEqual({ kind: "existing-member" });
  });
});
