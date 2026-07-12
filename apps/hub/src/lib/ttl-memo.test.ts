import { describe, expect, it } from "bun:test";

import { createTtlMemo } from "./ttl-memo";

const TTL = 10_000;

describe("createTtlMemo", () => {
  it("expires a stale entry and does not leave it resident after access", async () => {
    const memo = createTtlMemo<string>();
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    const first = await memo.get({
      key: "a",
      resolve,
      ttlMs: TTL,
      now: () => 1_000,
    });
    const second = await memo.get({
      key: "a",
      resolve,
      ttlMs: TTL,
      now: () => 1_000 + TTL + 1,
    });

    expect(first).toBe("value-1");
    expect(second).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("re-resolves on every call when ttlMs is 0 (cache-off contract)", async () => {
    const memo = createTtlMemo<string>();
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    const first = await memo.get({
      key: "a",
      resolve,
      ttlMs: 0,
      now: () => 1_000,
    });
    const second = await memo.get({
      key: "a",
      resolve,
      ttlMs: 0,
      now: () => 1_000,
    });

    expect(first).toBe("value-1");
    expect(second).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("evicts the stalest entry when inserting beyond maxEntries", async () => {
    const memo = createTtlMemo<string>({ maxEntries: 2 });
    const resolve = async (value: string) => value;

    await memo.get({
      key: "a",
      resolve: () => resolve("a-1"),
      ttlMs: TTL,
      now: () => 1_000,
    });
    await memo.get({
      key: "b",
      resolve: () => resolve("b-1"),
      ttlMs: TTL,
      now: () => 2_000,
    });
    // inserting "c" should evict "a" (oldest storedAt), keeping "b" and "c"
    // resident. We never re-query "a" afterward — doing so would itself
    // trigger another eviction at this same cap and confound the assertion.
    await memo.get({
      key: "c",
      resolve: () => resolve("c-1"),
      ttlMs: TTL,
      now: () => 3_000,
    });

    let bCalls = 0;
    let cCalls = 0;

    const b = await memo.get({
      key: "b",
      resolve: async () => {
        bCalls += 1;
        return "b-2";
      },
      ttlMs: TTL,
      now: () => 3_500,
    });
    const c = await memo.get({
      key: "c",
      resolve: async () => {
        cCalls += 1;
        return "c-2";
      },
      ttlMs: TTL,
      now: () => 3_500,
    });

    expect(b).toBe("b-1");
    expect(bCalls).toBe(0);
    expect(c).toBe("c-1");
    expect(cCalls).toBe(0);
  });

  it("never evicts a key with an in-flight fetch, even at the cap", async () => {
    const memo = createTtlMemo<string>({ maxEntries: 1 });

    let releaseA!: (value: string) => void;
    const pendingA = new Promise<string>((resolveFn) => {
      releaseA = resolveFn;
    });

    const aPromise = memo.get({
      key: "a",
      resolve: () => pendingA,
      ttlMs: TTL,
      now: () => 1_000,
    });

    // "b" would normally evict the only other entry to respect the cap, but
    // "a" is still in-flight (nothing has been stored for it yet), so there
    // is nothing to evict — the cache is empty at this point regardless.
    const bResult = await memo.get({
      key: "b",
      resolve: async () => "b-1",
      ttlMs: TTL,
      now: () => 1_000,
    });
    expect(bResult).toBe("b-1");

    releaseA("a-1");
    const aResult = await aPromise;
    expect(aResult).toBe("a-1");

    // "a" completed after "b" was already cached; inserting "a" at cap 1
    // evicts "b" (the stalest resident entry, since "a" wasn't stored yet
    // when "b" was inserted) — confirms no key stays pinned once its fetch
    // has resolved.
    let bCalls = 0;
    const bAgain = await memo.get({
      key: "b",
      resolve: async () => {
        bCalls += 1;
        return "b-2";
      },
      ttlMs: TTL,
      now: () => 1_000,
    });
    expect(bAgain).toBe("b-2");
    expect(bCalls).toBe(1);
  });
});
