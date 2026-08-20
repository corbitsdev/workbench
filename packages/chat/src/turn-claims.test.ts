import { describe, expect, test } from "bun:test";
import { createInMemoryTurnClaimStore } from "./turn-claims";

describe("createInMemoryTurnClaimStore", () => {
  test("the first tryClaim for a workbench wins", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(true);
  });

  test("a second tryClaim for the same workbench loses while the first is held", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await store.tryClaim({ workbenchId: "wb_1" });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(false);
  });

  test("claims on different workbenches never contend", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(true);
    await expect(store.tryClaim({ workbenchId: "wb_2" })).resolves.toBe(true);
  });

  test("release frees the claim for a fresh tryClaim", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await store.tryClaim({ workbenchId: "wb_1" });
    await store.release({ workbenchId: "wb_1" });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(true);
  });

  test("releasing a claim nobody holds is a harmless no-op", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await expect(
      store.release({ workbenchId: "wb_never_claimed" }),
    ).resolves.toBeUndefined();
  });

  test("a claim older than the TTL is reclaimable even without release — the crash/hang backstop", async () => {
    let now = 0;
    const store = createInMemoryTurnClaimStore({
      ttlMs: 1_000,
      now: () => now,
    });
    await store.tryClaim({ workbenchId: "wb_1" });
    now += 999;
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(false);
    now += 2;
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(true);
  });
});
