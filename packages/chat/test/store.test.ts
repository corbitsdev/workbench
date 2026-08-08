// Exercises the in-memory `ChatStore` used by routes.test.ts, since it
// is nontrivial enough (upsert semantics, per-tenant/per-principal
// scoping) to carry its own contract tests separate from the routes
// that call it.

import { expect, test } from "bun:test";
import { createInMemoryChatStore } from "../src/store";

test("createChannelSettings then getChannelSettings round-trips the row", async () => {
  const store = createInMemoryChatStore();
  await store.createChannelSettings({
    tenantId: "tnt_1",
    channelId: "chn_1",
    settings: { "chat/kind": "chat" },
    updatedBy: "prn_1",
  });

  const row = await store.getChannelSettings("tnt_1", "chn_1");
  expect(row?.settings["chat/kind"]).toBe("chat");
});

test("listChannelSettings scopes to tenant and filters by kind", async () => {
  const store = createInMemoryChatStore();
  await store.createChannelSettings({
    tenantId: "tnt_1",
    channelId: "chn_1",
    settings: { "chat/kind": "channel" },
    updatedBy: "prn_1",
  });
  await store.createChannelSettings({
    tenantId: "tnt_1",
    channelId: "chn_2",
    settings: { "chat/kind": "chat" },
    updatedBy: "prn_1",
  });
  await store.createChannelSettings({
    tenantId: "tnt_2",
    channelId: "chn_3",
    settings: { "chat/kind": "channel" },
    updatedBy: "prn_1",
  });

  const tenant1Channels = await store.listChannelSettings("tnt_1");
  expect(tenant1Channels).toHaveLength(2);

  const filtered = await store.listChannelSettings("tnt_1", "channel");
  expect(filtered.map((row) => row.channelId)).toEqual(["chn_1"]);
});

test("updateChannelSettings replaces the settings blob and rejects a missing channel", async () => {
  const store = createInMemoryChatStore();
  await store.createChannelSettings({
    tenantId: "tnt_1",
    channelId: "chn_1",
    settings: { "chat/pinned": false },
    updatedBy: "prn_1",
  });

  const updated = await store.updateChannelSettings({
    tenantId: "tnt_1",
    channelId: "chn_1",
    settings: { "chat/pinned": true },
    updatedBy: "prn_2",
  });
  expect(updated.settings["chat/pinned"]).toBe(true);
  expect(updated.updatedBy).toBe("prn_2");

  await expect(
    store.updateChannelSettings({
      tenantId: "tnt_1",
      channelId: "chn_missing",
      settings: {},
      updatedBy: "prn_1",
    }),
  ).rejects.toThrow();
});

test("getBenchSettings is undefined until a bench sets defaults, then upsertBenchSettings replaces them", async () => {
  const store = createInMemoryChatStore();
  expect(await store.getBenchSettings("tnt_1")).toBeUndefined();

  await store.upsertBenchSettings({
    tenantId: "tnt_1",
    settings: { "chat/contextWindow": 30 },
    updatedBy: "prn_1",
  });
  const first = await store.getBenchSettings("tnt_1");
  expect(first?.settings["chat/contextWindow"]).toBe(30);

  await store.upsertBenchSettings({
    tenantId: "tnt_1",
    settings: { "chat/contextWindow": 45 },
    updatedBy: "prn_2",
  });
  const second = await store.getBenchSettings("tnt_1");
  expect(second?.settings["chat/contextWindow"]).toBe(45);
  expect(second?.updatedBy).toBe("prn_2");

  expect(await store.getBenchSettings("tnt_2")).toBeUndefined();
});

test("putReadState upserts a per-principal cursor without disturbing other principals", async () => {
  const store = createInMemoryChatStore();
  await store.putReadState({
    tenantId: "tnt_1",
    channelId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenId: "mail_1",
  });
  await store.putReadState({
    tenantId: "tnt_1",
    channelId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastSeenId: "mail_2",
  });

  const alice = await store.getReadState("tnt_1", "chn_1", "prn_alice");
  expect(alice?.lastSeenId).toBe("mail_2");

  const bob = await store.getReadState("tnt_1", "chn_1", "prn_bob");
  expect(bob).toBeUndefined();
});
