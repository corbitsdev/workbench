import { describe, expect, it } from "bun:test";

import {
  buildMosaic,
  buildSparkline,
  cacheHitRate,
  computeDelta,
  fillDailySeries,
  formatCompact,
  ratePct,
} from "./metrics";

describe("computeDelta", () => {
  it("reports an upward percentage change against a positive baseline", () => {
    expect(computeDelta(150, 100)).toEqual({
      direction: "up",
      pct: 50,
      delta: 50,
      comparable: true,
    });
  });

  it("reports a downward change", () => {
    const d = computeDelta(80, 100);
    expect(d.direction).toBe("down");
    expect(d.pct).toBe(-20);
    expect(d.comparable).toBe(true);
  });

  it("returns a null percentage (not infinity) when the previous value is zero", () => {
    const d = computeDelta(10, 0);
    expect(d.direction).toBe("up");
    expect(d.pct).toBeNull();
    expect(d.delta).toBe(10);
    expect(d.comparable).toBe(true);
  });

  it("marks the delta not-comparable when there is no previous window", () => {
    expect(computeDelta(10, null)).toEqual({
      direction: "flat",
      pct: null,
      delta: 0,
      comparable: false,
    });
  });
});

describe("fillDailySeries", () => {
  const row = (date: string, turnCount: number) => ({
    date,
    turnCount,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  });

  it("inserts zero-filled days for gaps in the series", () => {
    const filled = fillDailySeries(
      [row("2026-06-01", 4), row("2026-06-03", 8)],
      "2026-06-01",
      "2026-06-03",
    );
    expect(filled.map((d) => d.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(filled.map((d) => d.turnCount)).toEqual([4, 0, 8]);
  });

  it("preserves existing rows by reference and pads beyond the data range", () => {
    const present = row("2026-06-02", 5);
    const filled = fillDailySeries([present], "2026-06-01", "2026-06-02");
    expect(filled).toHaveLength(2);
    expect(filled[0].turnCount).toBe(0);
    expect(filled[1]).toBe(present);
  });

  it("returns the input unchanged for an inverted range", () => {
    const input = [row("2026-06-05", 1)];
    expect(fillDailySeries(input, "2026-06-10", "2026-06-01")).toBe(input);
  });
});

describe("cacheHitRate", () => {
  it("computes cache reads as a share of total read tokens", () => {
    expect(cacheHitRate(75, 25)).toBe(25);
  });

  it("is zero when there are no read tokens at all", () => {
    expect(cacheHitRate(0, 0)).toBe(0);
  });
});

describe("ratePct", () => {
  it("guards against division by zero", () => {
    expect(ratePct(3, 0)).toBe(0);
  });
  it("computes a percentage of a whole", () => {
    expect(ratePct(3, 4)).toBe(75);
  });
});

describe("buildSparkline", () => {
  it("maps the max value to the top edge and the min to the bottom", () => {
    const { coords } = buildSparkline([0, 10, 5], 100, 40);
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual({ x: 0, y: 40 }); // min → bottom
    expect(coords[1]).toEqual({ x: 50, y: 0 }); // max → top
    expect(coords[2].y).toBeGreaterThan(0);
    expect(coords[2].y).toBeLessThan(40);
  });

  it("centres a flat series vertically", () => {
    const { coords } = buildSparkline([4, 4, 4], 100, 40);
    expect(coords.every((c) => c.y === 20)).toBe(true);
  });

  it("returns empty geometry for an empty series", () => {
    expect(buildSparkline([], 100, 40)).toEqual({ points: "", coords: [] });
  });
});

describe("buildMosaic", () => {
  it("turns raw parts into proportional percentages", () => {
    const segs = buildMosaic([
      { label: "in", value: 30 },
      { label: "out", value: 10 },
    ]);
    expect(segs[0].pct).toBe(75);
    expect(segs[1].pct).toBe(25);
  });

  it("yields zero-width segments when everything is zero", () => {
    const segs = buildMosaic([{ label: "in", value: 0 }]);
    expect(segs[0].pct).toBe(0);
  });
});

describe("formatCompact", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatCompact(1500)).toBe("1.5k");
    expect(formatCompact(2_000_000)).toBe("2M");
    expect(formatCompact(42)).toBe("42");
  });
});
