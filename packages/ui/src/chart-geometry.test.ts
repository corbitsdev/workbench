/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  buildAreaPath,
  buildLinePath,
  buildStepGraphEdgePath,
  layoutLinearStepCenters,
  niceMax,
  sequentialStepEdges,
  seriesToCoords,
  stepGraphEdgeEndpoints,
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

describe("step graph layout", () => {
  it("spaces horizontal centers across the span with insets", () => {
    const centers = layoutLinearStepCenters({
      count: 3,
      span: 100,
      crossCenter: 20,
      nodeInset: 10,
      axis: "horizontal",
    });
    expect(centers.map((c) => c.x)).toEqual([10, 50, 90]);
    expect(centers.every((c) => c.y === 20)).toBe(true);
  });

  it("stacks vertical centers top-to-bottom", () => {
    const centers = layoutLinearStepCenters({
      count: 2,
      span: 80,
      crossCenter: 15,
      nodeInset: 8,
      axis: "vertical",
    });
    expect(centers[0]).toEqual({ x: 15, y: 8 });
    expect(centers[1]).toEqual({ x: 15, y: 72 });
  });

  it("anchors edge endpoints on node boundaries", () => {
    const endpoints = stepGraphEdgeEndpoints(
      { x: 10, y: 20 },
      { x: 90, y: 20 },
      12,
      "horizontal",
    );
    expect(endpoints.from).toEqual({ x: 22, y: 20 });
    expect(endpoints.to).toEqual({ x: 78, y: 20 });
  });

  it("builds a connector path between two nodes", () => {
    const path = buildStepGraphEdgePath(
      { x: 0, y: 10 },
      { x: 100, y: 10 },
      5,
      "horizontal",
    );
    expect(path).toBe("M5 10 L95 10");
  });

  it("derives sequential edges from step ids", () => {
    expect(sequentialStepEdges(["a", "b", "c"])).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(sequentialStepEdges(["solo"])).toEqual([]);
  });
});
