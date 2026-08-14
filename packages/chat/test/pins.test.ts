// Store-level round trip for pinned messages: pin/unpin/list, idempotent
// re-pin, and tenant isolation — the in-memory `PinStore`'s contract.
import { describe, expect, test } from "bun:test";

import { createInMemoryPinStore } from "../src/pins";

const TENANT = "tnt_1";
const CHANNEL = "run_channel1";

describe("PinStore", () => {
  test("pinning then listing returns the pinned row", async () => {
    const store = createInMemoryPinStore();
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });

    const pins = await store.listPins(TENANT, CHANNEL);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ messageId: "m1", pinnedBy: "prn_alice" });
  });

  test("pinning an already-pinned message is idempotent — one row, refreshed", async () => {
    const store = createInMemoryPinStore();
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_bob",
    });

    const pins = await store.listPins(TENANT, CHANNEL);
    expect(pins).toHaveLength(1);
    expect(pins[0]?.pinnedBy).toBe("prn_bob");
  });

  test("unpinning removes the row", async () => {
    const store = createInMemoryPinStore();
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });
    await store.unpinMessage(TENANT, CHANNEL, "m1");

    const pins = await store.listPins(TENANT, CHANNEL);
    expect(pins).toEqual([]);
  });

  test("unpinning a message that was never pinned is a harmless no-op", async () => {
    const store = createInMemoryPinStore();
    await store.unpinMessage(TENANT, CHANNEL, "m_ghost");
    expect(await store.listPins(TENANT, CHANNEL)).toEqual([]);
  });

  test("newest pin first", async () => {
    const store = createInMemoryPinStore();
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.pinMessage({
      tenantId: TENANT,
      channelId: CHANNEL,
      messageId: "m2",
      pinnedBy: "prn_alice",
    });

    const pins = await store.listPins(TENANT, CHANNEL);
    expect(pins.map((p) => p.messageId)).toEqual(["m2", "m1"]);
  });

  test("tenant isolation: a channel pin in one tenant never appears under another's", async () => {
    const store = createInMemoryPinStore();
    await store.pinMessage({
      tenantId: "tnt_1",
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });
    await store.pinMessage({
      tenantId: "tnt_2",
      channelId: CHANNEL,
      messageId: "m1",
      pinnedBy: "prn_alice",
    });

    expect(await store.listPins("tnt_1", CHANNEL)).toHaveLength(1);
    expect(await store.listPins("tnt_2", CHANNEL)).toHaveLength(1);
  });
});
