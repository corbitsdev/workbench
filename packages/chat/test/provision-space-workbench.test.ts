// `provisionSpaceWorkbench`'s own contract: mints a new `kind: "workbench"`
// space exactly the way `POST /workbenches` does (mint tenant, launch host,
// compensate on launch failure), used by a caller — a routine's create
// route, chiefly — that needs a fresh destination handed back rather than
// collected from a picker first.
import { describe, expect, test } from "bun:test";

import { provisionSpaceWorkbench } from "../src/workbench-service";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { createInMemoryChatStore } from "../src/store";
import { fakePlatform, TENANT } from "./test-support";

const TURN_TIMEOUT_MS = 60_000;

describe("provisionSpaceWorkbench", () => {
  test("mints a workbench tenant, launches its host, and writes base settings", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform();

    const result = await provisionSpaceWorkbench(
      { tenancy, platform, store, turnTimeoutMs: TURN_TIMEOUT_MS },
      {
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        creatorPrincipalId: "prn_alice",
        creatorUserId: "usr_alice",
        name: "Morning digest",
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

  test("compensates (deletes) the minted tenant when the host launch fails", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      launchWorkbench: async () => {
        throw new Error("launch failed");
      },
    });

    await expect(
      provisionSpaceWorkbench(
        { tenancy, platform, store, turnTimeoutMs: TURN_TIMEOUT_MS },
        {
          tenantId: TENANT.id,
          tenantDomain: TENANT.domain,
          creatorPrincipalId: "prn_alice",
          creatorUserId: "usr_alice",
          name: "Doomed space",
        },
      ),
    ).rejects.toThrow("launch failed");

    // Nothing settled: no settings row was ever written for a tenant
    // that never finished launching.
    const links = await tenancy.listChildWorkbenchTenancies(TENANT.id);
    expect(links).toHaveLength(0);
  });

  test("the returned compensate() undoes the mint", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform();

    const result = await provisionSpaceWorkbench(
      { tenancy, platform, store, turnTimeoutMs: TURN_TIMEOUT_MS },
      {
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        creatorPrincipalId: "prn_alice",
        creatorUserId: "usr_alice",
        name: "Undo me",
      },
    );

    await result.compensate();
    const link = await tenancy.getWorkbenchTenancy(result.workbenchId);
    expect(link).toBeUndefined();
  });
});
