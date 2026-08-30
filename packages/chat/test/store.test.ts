// Exercises the in-memory `ChatStore` used by routes.test.ts, since it
// is nontrivial enough (upsert semantics, per-tenant/per-principal
// scoping) to carry its own contract tests separate from the routes
// that call it.

import { expect, test } from "bun:test";
import { addParticipant, removeParticipant } from "../src/participants";
import { createInMemoryChatStore } from "../src/store";

test("createWorkbenchSettings then getWorkbenchSettings round-trips the row", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: { "chat/kind": "chat" },
    updatedBy: "prn_1",
  });

  const row = await store.getWorkbenchSettings("tnt_1", "chn_1");
  expect(row?.settings["chat/kind"]).toBe("chat");
});

test("listWorkbenchSettings scopes to tenant and filters by kind", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: { "chat/kind": "workbench" },
    updatedBy: "prn_1",
  });
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_2",
    settings: { "chat/kind": "chat" },
    updatedBy: "prn_1",
  });
  await store.createWorkbenchSettings({
    tenantId: "tnt_2",
    workbenchId: "chn_3",
    settings: { "chat/kind": "workbench" },
    updatedBy: "prn_1",
  });

  const tenant1Workbenches = await store.listWorkbenchSettings("tnt_1");
  expect(tenant1Workbenches).toHaveLength(2);

  const filtered = await store.listWorkbenchSettings("tnt_1", "workbench");
  expect(filtered.map((row) => row.workbenchId)).toEqual(["chn_1"]);
});

test("updateWorkbenchSettings replaces the settings blob and rejects a missing workbench", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: { "chat/pinned": false },
    updatedBy: "prn_1",
  });

  const updated = await store.updateWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: { "chat/pinned": true },
    updatedBy: "prn_2",
  });
  expect(updated.settings["chat/pinned"]).toBe(true);
  expect(updated.updatedBy).toBe("prn_2");

  await expect(
    store.updateWorkbenchSettings({
      tenantId: "tnt_1",
      workbenchId: "chn_missing",
      settings: {},
      updatedBy: "prn_1",
    }),
  ).rejects.toThrow();
});

test("mutateWorkbenchParticipants folds `mutate` over the current list and writes only that key back", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: { "chat/kind": "workbench", "chat/pinned": true },
    updatedBy: "prn_1",
  });

  const row = await store.mutateWorkbenchParticipants({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    updatedBy: "prn_2",
    mutate: (participants) => addParticipant(participants, "prn_bob", "bob"),
  });

  expect(row.settings["chat/participants"]).toEqual([
    { address: "prn_bob", handle: "bob" },
  ]);
  // Untouched keys survive exactly as they were — this is the targeted
  // merge the whole-blob `updateWorkbenchSettings` never gave.
  expect(row.settings["chat/kind"]).toBe("workbench");
  expect(row.settings["chat/pinned"]).toBe(true);
  expect(row.updatedBy).toBe("prn_2");
});

test("mutateWorkbenchParticipants removing a participant leaves the rest untouched", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    settings: {
      "chat/participants": [
        { address: "prn_bob", handle: "bob" },
        { address: "prn_carol", handle: "carol" },
      ],
    },
    updatedBy: "prn_1",
  });

  const row = await store.mutateWorkbenchParticipants({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    updatedBy: "prn_1",
    mutate: (participants) => removeParticipant(participants, "prn_bob"),
  });

  expect(row.settings["chat/participants"]).toEqual([
    { address: "prn_carol", handle: "carol" },
  ]);
});

test("mutateWorkbenchParticipants rejects a missing workbench", async () => {
  const store = createInMemoryChatStore();
  await expect(
    store.mutateWorkbenchParticipants({
      tenantId: "tnt_1",
      workbenchId: "chn_missing",
      updatedBy: "prn_1",
      mutate: (participants) => [...participants],
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
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenId: "mail_1",
  });
  await store.putReadState({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastSeenId: "mail_2",
  });

  const alice = await store.getReadState("tnt_1", "chn_1", "prn_alice");
  expect(alice?.lastSeenId).toBe("mail_2");

  const bob = await store.getReadState("tnt_1", "chn_1", "prn_bob");
  expect(bob).toBeUndefined();
});

test("putReadState never moves the cursor backward when a stale write lands after a newer one", async () => {
  const store = createInMemoryChatStore();
  await store.putReadState({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastSeenId: "mail_2",
  });

  const result = await store.putReadState({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenId: "mail_1",
  });

  expect(result.lastSeenId).toBe("mail_2");
  expect(result.lastSeenCreatedAt).toEqual(
    new Date("2026-01-02T00:00:00.000Z"),
  );

  const alice = await store.getReadState("tnt_1", "chn_1", "prn_alice");
  expect(alice?.lastSeenId).toBe("mail_2");
});

test("putReadState still lands a same-millisecond forward move to a different message", async () => {
  const store = createInMemoryChatStore();
  const sameCreatedAt = new Date("2026-01-02T00:00:00.001Z");
  await store.putReadState({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: sameCreatedAt,
    lastSeenId: "mail_2",
  });

  const result = await store.putReadState({
    tenantId: "tnt_1",
    workbenchId: "chn_1",
    principalId: "prn_alice",
    lastSeenCreatedAt: sameCreatedAt,
    lastSeenId: "mail_3",
  });

  expect(result.lastSeenId).toBe("mail_3");

  const alice = await store.getReadState("tnt_1", "chn_1", "prn_alice");
  expect(alice?.lastSeenId).toBe("mail_3");
});
