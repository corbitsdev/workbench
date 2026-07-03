/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  buildAreaPath,
  buildLinePath,
  niceMax,
  seriesToCoords,
} from "./chart-geometry";

describe("seriesToCoords", () => {
  it("pins value 0 to the bottom and the max to the top on a zero baseline", () => {
    const coords = seriesToCoords([0, 10], 100, 50);
    expect(coords[0]!.y).toBe(50);
    expect(coords[1]!.y).toBe(0);
  });

  it("spaces points evenly across the width", () => {
    const coords = seriesToCoords([1, 2, 3], 100, 50);
    expect(coords.map((c) => c.x)).toEqual([0, 50, 100]);
  });

  it("centers a single point", () => {
    expect(seriesToCoords([5], 100, 50)[0]!.x).toBe(50);
  });

  it("uses an explicit max so multiple series share a scale", () => {
    // With max 20, a value of 10 lands at the vertical midpoint, not the top.
    expect(seriesToCoords([10], 100, 50, 20)[0]!.y).toBe(25);
  });

  it("floors an all-zero series to the baseline instead of dividing by zero", () => {
    expect(seriesToCoords([0, 0], 100, 50).every((c) => c.y === 50)).toBe(true);
  });

  it("returns no coordinates for an empty series", () => {
    expect(seriesToCoords([], 100, 50)).toEqual([]);
  });
});

describe("buildLinePath / buildAreaPath", () => {
  it("starts the line with a move then line commands", () => {
    const path = buildLinePath(seriesToCoords([0, 10], 100, 50));
    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("L");
  });

  it("closes the area path back down to the baseline", () => {
    const coords = seriesToCoords([0, 10], 100, 50);
    const area = buildAreaPath(coords, 50);
    expect(area.endsWith("Z")).toBe(true);
    expect(area).toContain("L100 50");
  });

  it("returns empty strings for no points", () => {
    expect(buildLinePath([])).toBe("");
    expect(buildAreaPath([], 50)).toBe("");
  });
});

describe("niceMax", () => {
  it("rounds up to a readable round number", () => {
    expect(niceMax(7)).toBe(10);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(120)).toBe(200);
  });

  it("returns 1 for non-positive input so a scale always exists", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });
});
