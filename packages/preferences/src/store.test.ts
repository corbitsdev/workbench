import { describe, expect, test } from "bun:test";

import { createMemoryPreferencesStore } from "./store";

describe("createMemoryPreferencesStore", () => {
  test("returns {} for a tenant/principal with no stored preferences", async () => {
    const store = createMemoryPreferencesStore();
    expect(await store.getPreferences("tnt_1", "prn_1")).toEqual({});
  });

  test("patchPreferences upserts and returns the merged object", async () => {
    const store = createMemoryPreferencesStore();
    const merged = await store.patchPreferences("tnt_1", "prn_1", {
      "shell.col2Collapsed": true,
    });
    expect(merged).toEqual({ "shell.col2Collapsed": true });
    expect(await store.getPreferences("tnt_1", "prn_1")).toEqual({
      "shell.col2Collapsed": true,
    });
  });

  test("a later patch shallow-merges, preserving unrelated existing keys", async () => {
    const store = createMemoryPreferencesStore();
    await store.patchPreferences("tnt_1", "prn_1", {
      "shell.col2Collapsed": true,
      "shell.theme": "dark",
    });
    const merged = await store.patchPreferences("tnt_1", "prn_1", {
      "shell.col2Collapsed": false,
    });
    expect(merged).toEqual({
      "shell.col2Collapsed": false,
      "shell.theme": "dark",
    });
  });

  test("a patch key overwrites the prior value for that key", async () => {
    const store = createMemoryPreferencesStore();
    await store.patchPreferences("tnt_1", "prn_1", { count: 1 });
    const merged = await store.patchPreferences("tnt_1", "prn_1", {
      count: 2,
    });
    expect(merged).toEqual({ count: 2 });
  });

  test("tenants are isolated from each other", async () => {
    const store = createMemoryPreferencesStore();
    await store.patchPreferences("tnt_1", "prn_1", { flag: true });
    expect(await store.getPreferences("tnt_2", "prn_1")).toEqual({});
  });

  test("principals within the same tenant are isolated from each other", async () => {
    const store = createMemoryPreferencesStore();
    await store.patchPreferences("tnt_1", "prn_1", { flag: true });
    expect(await store.getPreferences("tnt_1", "prn_2")).toEqual({});
  });

  test("returned objects are copies, not live references into the store", async () => {
    const store = createMemoryPreferencesStore();
    await store.patchPreferences("tnt_1", "prn_1", { flag: true });
    const read = await store.getPreferences("tnt_1", "prn_1");
    (read as Record<string, unknown>)["flag"] = false;
    expect(await store.getPreferences("tnt_1", "prn_1")).toEqual({
      flag: true,
    });
  });
});
