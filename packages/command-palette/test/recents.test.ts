import { describe, expect, test } from "bun:test";

import {
  addRecentEntry,
  createRecentsStore,
  removeRecentEntry,
  type RecentEntry,
  type RecentsStorage,
} from "../src/recents";

function entry(id: string, title = id): RecentEntry {
  return { kind: "channel", id, title };
}

describe("addRecentEntry", () => {
  test("prepends a new entry", () => {
    expect(addRecentEntry([], entry("a"))).toEqual([entry("a")]);
  });

  test("moves a re-visited entry to the front instead of duplicating it", () => {
    const result = addRecentEntry([entry("a"), entry("b")], entry("b"));
    expect(result).toEqual([entry("b"), entry("a")]);
  });

  test("caps the list at max, dropping the oldest", () => {
    const seeded = ["a", "b", "c", "d", "e"].map((id) => entry(id));
    const result = addRecentEntry(seeded, entry("f"), 5);
    expect(result.map((e) => e.id)).toEqual(["f", "a", "b", "c", "d"]);
  });

  test("distinguishes entries with the same id but different kind", () => {
    const channelA = { kind: "channel", id: "a", title: "a" };
    const pageA = { kind: "page", id: "a", title: "a" };
    const result = addRecentEntry([channelA], pageA);
    expect(result).toEqual([pageA, channelA]);
  });
});

describe("removeRecentEntry", () => {
  test("drops the entry matching kind+id", () => {
    const result = removeRecentEntry(
      [entry("a"), entry("b"), entry("c")],
      entry("b"),
    );
    expect(result).toEqual([entry("a"), entry("c")]);
  });

  test("leaves the list untouched when nothing matches", () => {
    const seeded = [entry("a"), entry("b")];
    expect(removeRecentEntry(seeded, entry("z"))).toEqual(seeded);
  });

  test("a same-id different-kind entry is untouched — kind+id is the key", () => {
    const channelA = { kind: "channel", id: "a", title: "a" };
    const pageA = { kind: "page", id: "a", title: "a" };
    const result = removeRecentEntry([channelA, pageA], channelA);
    expect(result).toEqual([pageA]);
  });
});

function inMemoryStorage(): RecentsStorage {
  const backing = new Map<string, string>();
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      backing.set(key, value);
    },
  };
}

describe("createRecentsStore", () => {
  test("starts empty when nothing is stored", () => {
    const store = createRecentsStore(inMemoryStorage(), "bench:1");
    expect(store.load()).toEqual([]);
  });

  test("push persists and load reflects it", () => {
    const store = createRecentsStore(inMemoryStorage(), "bench:1");
    store.push(entry("a"));
    const after = store.push(entry("b"));
    expect(after).toEqual([entry("b"), entry("a")]);
    expect(store.load()).toEqual([entry("b"), entry("a")]);
  });

  test("push never throws when setItem throws (quota, disabled storage) — returns the updated list anyway", () => {
    const throwingStorage: RecentsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createRecentsStore(throwingStorage, "bench:1");
    let result: readonly RecentEntry[] | undefined;
    expect(() => {
      result = store.push(entry("a"));
    }).not.toThrow();
    expect(result).toEqual([entry("a")]);
  });

  test("remove persists and load reflects it — self-healing a stale entry (e.g. a channel that 404s)", () => {
    const store = createRecentsStore(inMemoryStorage(), "bench:1");
    store.push(entry("a"));
    store.push(entry("b"));
    const after = store.remove(entry("a"));
    expect(after).toEqual([entry("b")]);
    expect(store.load()).toEqual([entry("b")]);
  });

  test("remove never throws when setItem throws — returns the updated list anyway", () => {
    const throwingStorage: RecentsStorage = {
      getItem: () => JSON.stringify([entry("a"), entry("b")]),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createRecentsStore(throwingStorage, "bench:1");
    let result: readonly RecentEntry[] | undefined;
    expect(() => {
      result = store.remove(entry("a"));
    }).not.toThrow();
    expect(result).toEqual([entry("b")]);
  });

  test("two keys do not share state", () => {
    const storage = inMemoryStorage();
    const benchOne = createRecentsStore(storage, "bench:1");
    const benchTwo = createRecentsStore(storage, "bench:2");
    benchOne.push(entry("a"));
    expect(benchTwo.load()).toEqual([]);
  });

  test("malformed stored JSON is treated as empty", () => {
    const storage = inMemoryStorage();
    storage.setItem("bench:1", "{not json");
    const store = createRecentsStore(storage, "bench:1");
    expect(store.load()).toEqual([]);
  });

  test("a stored non-array is treated as empty", () => {
    const storage = inMemoryStorage();
    storage.setItem("bench:1", JSON.stringify({ oops: true }));
    const store = createRecentsStore(storage, "bench:1");
    expect(store.load()).toEqual([]);
  });

  test("stored entries missing required fields are dropped", () => {
    const storage = inMemoryStorage();
    storage.setItem(
      "bench:1",
      JSON.stringify([entry("a"), { id: "bad" }, entry("b")]),
    );
    const store = createRecentsStore(storage, "bench:1");
    expect(store.load()).toEqual([entry("a"), entry("b")]);
  });
});
