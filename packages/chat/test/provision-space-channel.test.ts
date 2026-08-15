// `provisionSpaceChannel`'s own contract: mints a new `kind: "channel"`
// space exactly the way `POST /channels` does (mint tenant, launch host,
// compensate on launch failure), used by a caller — a routine's create
// route, chiefly — that needs a fresh destination handed back rather than
// collected from a picker first.
import { describe, expect, test } from "bun:test";

import { provisionSpaceChannel } from "../src/channel-service";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";
import { createInMemoryChatStore } from "../src/store";
import { fakePlatform, TENANT } from "./test-support";

const TURN_TIMEOUT_MS = 60_000;

describe("provisionSpaceChannel", () => {
  test("mints a channel tenant, launches its host, and writes base settings", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform();

    const result = await provisionSpaceChannel(
      { tenancy, platform, store, turnTimeoutMs: TURN_TIMEOUT_MS },
      {
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        creatorPrincipalId: "prn_alice",
        creatorUserId: "usr_alice",
        name: "Morning digest",
      },
    );

    expect(typeof result.channelId).toBe("string");
    const link = await tenancy.getChannelTenancy(result.channelId);
    expect(link).toBeDefined();

    const settings = await store.getChannelSettings(
      TENANT.id,
      result.channelId,
    );
    expect(settings?.settings["chat/kind"]).toBe("channel");
    expect(settings?.settings["chat/name"]).toBe("Morning digest");
  });

  test("compensates (deletes) the minted tenant when the host launch fails", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      launchChannel: async () => {
        throw new Error("launch failed");
      },
    });

    await expect(
      provisionSpaceChannel(
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
    const links = await tenancy.listChildChannelTenancies(TENANT.id);
    expect(links).toHaveLength(0);
  });

  test("the returned compensate() undoes the mint", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    const store = createInMemoryChatStore();
    const platform = fakePlatform();

    const result = await provisionSpaceChannel(
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
    const link = await tenancy.getChannelTenancy(result.channelId);
    expect(link).toBeUndefined();
  });
});
