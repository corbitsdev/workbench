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

describe("pins", () => {
  test("loadPins returns empty for missing or corrupt storage", () => {
    expect(loadPins(memoryStorage())).toEqual([]);
    expect(
      loadPins(memoryStorage({ "workbench.shell.pins": "not-json" })),
    ).toEqual([]);
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
    savePins(pins, storage);
    expect(loadPins(storage)).toEqual(pins);
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
