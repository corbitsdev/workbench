import { describe, expect, test } from "bun:test";
import { formatElapsedMs } from "./use-elapsed-time";

describe("formatElapsedMs", () => {
  test("formats sub-minute durations as seconds", () => {
    expect(formatElapsedMs(0)).toBe("0s");
    expect(formatElapsedMs(42_000)).toBe("42s");
    expect(formatElapsedMs(59_000)).toBe("59s");
  });

  test("formats minute-plus durations as Mm Ns", () => {
    expect(formatElapsedMs(60_000)).toBe("1m 0s");
    expect(formatElapsedMs(125_000)).toBe("2m 5s");
  });
});
