import { describe, expect, test } from "bun:test";

import { loadPins, savePins, togglePin } from "./pins";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

const TEST_KEY = "test.pins";

describe("pins", () => {
  test("loadPins returns empty for missing or corrupt storage", () => {
    expect(loadPins(memoryStorage(), TEST_KEY)).toEqual([]);
    expect(
      loadPins(memoryStorage({ [TEST_KEY]: "not-json" }), TEST_KEY),
    ).toEqual([]);
  });

  test("loadPins reads only the given key, not some other host's pins", () => {
    const storage = memoryStorage({
      "other-host.pins": JSON.stringify([
        { id: "x", kind: "channel", label: "X", href: "/c/x" },
      ]),
    });
    expect(loadPins(storage, TEST_KEY)).toEqual([]);
  });

  test("savePins and loadPins round-trip valid pins", () => {
    const storage = memoryStorage();
    const pins = [
      {
        id: "ch_1",
        kind: "channel" as const,
        label: "general",
        href: "/c/ch_1",
      },
    ];
    savePins(pins, storage, TEST_KEY);
    expect(loadPins(storage, TEST_KEY)).toEqual(pins);
  });

  test("togglePin adds and removes by id+kind", () => {
    const pin = {
      id: "a1",
      kind: "agent" as const,
      label: "Myra",
      href: "/agents",
    };
    const added = togglePin([], pin);
    expect(added).toEqual([pin]);
    expect(togglePin(added, pin)).toEqual([]);
  });
});
