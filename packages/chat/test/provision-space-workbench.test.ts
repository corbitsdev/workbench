// `provisionSpaceWorkbench`'s own contract: mints a new `kind: "workbench"`
// space exactly the way `POST /workbenches` does (mint tenant, write base
// settings — a workbench is data, nothing launches), used by a caller — a
// routine's create route, chiefly — that needs a fresh destination handed
// back rather than collected from a picker first.
import { describe, expect, test } from "bun:test";

import { provisionSpaceWorkbench } from "../src/workbench-service";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { createInMemoryChatStore } from "../src/store";
import { TENANT } from "./test-support";

describe("provisionSpaceWorkbench", () => {
  test("mints a workbench tenant and writes base settings", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();

    const result = await provisionSpaceWorkbench(
      { tenancy, store },
      {
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        creatorPrincipalId: "prn_alice",
        creatorUserId: "usr_alice",
        name: "Morning digest",
        cookies: ["session=test"],
      },
    );

    expect(typeof result.workbenchId).toBe("string");
    const link = await tenancy.getWorkbenchTenancy(result.workbenchId);
    expect(link).toBeDefined();

    const settings = await store.getWorkbenchSettings(
      TENANT.id,
      result.workbenchId,
    );
    expect(settings?.settings["chat/kind"]).toBe("workbench");
    expect(settings?.settings["chat/name"]).toBe("Morning digest");
  });

  test("compensates (deletes) the minted tenant when the settings write fails", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();
    store.createWorkbenchSettings = async () => {
      throw new Error("settings write failed");
    };

    await expect(
      provisionSpaceWorkbench(
        { tenancy, store },
        {
          tenantId: TENANT.id,
          tenantDomain: TENANT.domain,
          creatorPrincipalId: "prn_alice",
          creatorUserId: "usr_alice",
          name: "Doomed space",
          cookies: ["session=test"],
        },
      ),
    ).rejects.toThrow("settings write failed");

    // Nothing settled: the minted tenant was compensated away.
    const links = await tenancy.listChildWorkbenchTenancies(TENANT.id);
    expect(links).toHaveLength(0);
  });

  test("the returned compensate() undoes the mint", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();

    const result = await provisionSpaceWorkbench(
      { tenancy, store },
      {
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        creatorPrincipalId: "prn_alice",
        creatorUserId: "usr_alice",
        name: "Undo me",
        cookies: ["session=test"],
      },
    );

    await result.compensate();
    const link = await tenancy.getWorkbenchTenancy(result.workbenchId);
    expect(link).toBeUndefined();
  });
});
