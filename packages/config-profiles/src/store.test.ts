import { describe, expect, test } from "bun:test";

import { createInMemoryConfigProfileStore } from "./store";

describe("createInMemoryConfigProfileStore", () => {
  test("createProfile stores and returns the row, listable by tenant", async () => {
    const store = createInMemoryConfigProfileStore();
    const row = await store.createProfile({
      tenantId: "tnt_1",
      name: "Fast & cheap",
      entries: [{ provider: "OpenAI", model: "gpt-5" }],
      createdBy: "prn_1",
    });
    expect(row.name).toBe("Fast & cheap");
    expect(row.description).toBeNull();
    expect(await store.listProfiles("tnt_1")).toEqual([row]);
  });

  test("getProfile returns undefined for an unknown id", async () => {
    const store = createInMemoryConfigProfileStore();
    expect(await store.getProfile("tnt_1", "nope")).toBeUndefined();
  });

  test("getProfile scopes to the owning tenant", async () => {
    const store = createInMemoryConfigProfileStore();
    const row = await store.createProfile({
      tenantId: "tnt_1",
      name: "P",
      entries: [],
      createdBy: "prn_1",
    });
    expect(await store.getProfile("tnt_2", row.id)).toBeUndefined();
    expect(await store.getProfile("tnt_1", row.id)).toEqual(row);
  });

  test("listProfiles is isolated per tenant", async () => {
    const store = createInMemoryConfigProfileStore();
    await store.createProfile({
      tenantId: "tnt_1",
      name: "A",
      entries: [],
      createdBy: "prn_1",
    });
    expect(await store.listProfiles("tnt_2")).toEqual([]);
  });

  test("updateProfile patches name/description/entries and bumps updatedAt", async () => {
    const store = createInMemoryConfigProfileStore();
    const created = await store.createProfile({
      tenantId: "tnt_1",
      name: "A",
      entries: [{ provider: "OpenAI", model: "gpt-5" }],
      createdBy: "prn_1",
    });
    const updated = await store.updateProfile("tnt_1", created.id, {
      name: "B",
      description: "renamed",
      entries: [{ provider: "Anthropic", model: "claude", disabled: true }],
    });
    expect(updated.name).toBe("B");
    expect(updated.description).toBe("renamed");
    expect(updated.entries).toEqual([
      { provider: "Anthropic", model: "claude", disabled: true },
    ]);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );
  });

  test("updateProfile throws for a profile in a different tenant", async () => {
    const store = createInMemoryConfigProfileStore();
    const created = await store.createProfile({
      tenantId: "tnt_1",
      name: "A",
      entries: [],
      createdBy: "prn_1",
    });
    await expect(
      store.updateProfile("tnt_2", created.id, { name: "B" }),
    ).rejects.toThrow();
  });

  test("deleteProfile removes the row and returns true; a second delete returns false", async () => {
    const store = createInMemoryConfigProfileStore();
    const created = await store.createProfile({
      tenantId: "tnt_1",
      name: "A",
      entries: [],
      createdBy: "prn_1",
    });
    expect(await store.deleteProfile("tnt_1", created.id)).toBe(true);
    expect(await store.getProfile("tnt_1", created.id)).toBeUndefined();
    expect(await store.deleteProfile("tnt_1", created.id)).toBe(false);
  });

  test("deleteProfile scoped to the wrong tenant is a no-op", async () => {
    const store = createInMemoryConfigProfileStore();
    const created = await store.createProfile({
      tenantId: "tnt_1",
      name: "A",
      entries: [],
      createdBy: "prn_1",
    });
    expect(await store.deleteProfile("tnt_2", created.id)).toBe(false);
    expect(await store.getProfile("tnt_1", created.id)).toBeDefined();
  });
});
