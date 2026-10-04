import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelInfo } from "@intx/types";

import {
  clearProviderSkipWhenUsable,
  isProviderSkipped,
  setProviderSkipped,
} from "./provider-skip";

const store = new Map<string, string>();

function model(offerings: number): ModelInfo {
  return { offerings: Array.from({ length: offerings }, () => ({})) } as unknown as ModelInfo;
}

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("clearProviderSkipWhenUsable", () => {
  test("clears the skip flag once a model has an offering", () => {
    setProviderSkipped("u1", true);
    clearProviderSkipWhenUsable("u1", [model(1)]);
    expect(isProviderSkipped("u1")).toBe(false);
  });

  test("keeps the skip flag while no model has an offering", () => {
    setProviderSkipped("u1", true);
    clearProviderSkipWhenUsable("u1", [model(0)]);
    expect(isProviderSkipped("u1")).toBe(true);
  });
});
