import { describe, expect, test } from "bun:test";

import { createMemoryBenchSettingsStore } from "./store";

describe("createMemoryBenchSettingsStore", () => {
  test("returns null purpose/type for a tenant with no stored settings", async () => {
    const store = createMemoryBenchSettingsStore();
    const settings = await store.getBenchSettings("tnt_1");
    expect(settings.purpose).toBeNull();
    expect(settings.type).toBeNull();
  });

  test("patchBenchSettings upserts and returns the merged record", async () => {
    const store = createMemoryBenchSettingsStore();
    const merged = await store.patchBenchSettings("tnt_1", {
      purpose: "Launch planning",
      type: "global",
    });
    expect(merged.purpose).toBe("Launch planning");
    expect(merged.type).toBe("global");

    const read = await store.getBenchSettings("tnt_1");
    expect(read.purpose).toBe("Launch planning");
    expect(read.type).toBe("global");
  });

  test("a later patch with only one key preserves the other's stored value", async () => {
    const store = createMemoryBenchSettingsStore();
    await store.patchBenchSettings("tnt_1", {
      purpose: "Launch planning",
      type: "global",
    });
    const merged = await store.patchBenchSettings("tnt_1", {
      purpose: "Q3 launch planning",
    });
    expect(merged.purpose).toBe("Q3 launch planning");
    expect(merged.type).toBe("global");
  });

  test("tenants are isolated from each other", async () => {
    const store = createMemoryBenchSettingsStore();
    await store.patchBenchSettings("tnt_1", { purpose: "one" });
    const other = await store.getBenchSettings("tnt_2");
    expect(other.purpose).toBeNull();
  });
});
