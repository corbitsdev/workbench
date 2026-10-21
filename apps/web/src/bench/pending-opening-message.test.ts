import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearOpeningMessage, parkOpeningMessage, readOpeningMessage } from "../opening-message";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("opening message tenant isolation", () => {
  test("parking and clearing an opening message is scoped to the originating workbench tenant", () => {
    parkOpeningMessage("tnt_bench_a", "Draft the Q4 launch note");
    parkOpeningMessage("tnt_bench_b", "Audit the billing webhook");

    expect(readOpeningMessage("tnt_bench_a")).toBe("Draft the Q4 launch note");
    expect(readOpeningMessage("tnt_bench_b")).toBe("Audit the billing webhook");

    clearOpeningMessage("tnt_bench_a");

    expect(readOpeningMessage("tnt_bench_a")).toBeNull();
    expect(readOpeningMessage("tnt_bench_b")).toBe("Audit the billing webhook");
  });
});
