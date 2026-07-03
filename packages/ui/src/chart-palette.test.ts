/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { CHART_SERIES, seriesColor } from "./chart-palette";

describe("seriesColor", () => {
  it("returns the fixed slot for an index", () => {
    expect(seriesColor(0).key).toBe(CHART_SERIES[0]!.key);
    expect(seriesColor(1).key).toBe(CHART_SERIES[1]!.key);
  });

  it("clamps past the last slot instead of cycling", () => {
    const last = CHART_SERIES[CHART_SERIES.length - 1];
    expect(seriesColor(CHART_SERIES.length + 5).key).toBe(last!.key);
    // must NOT wrap back to slot 0
    expect(seriesColor(CHART_SERIES.length).key).not.toBe(CHART_SERIES[0]!.key);
  });

  it("resolves a negative index to the first slot", () => {
    expect(seriesColor(-3).key).toBe(CHART_SERIES[0]!.key);
  });

  it("exposes tokenized class names, never raw hex", () => {
    for (const slot of CHART_SERIES) {
      expect(slot.stroke.startsWith("stroke-")).toBe(true);
      expect(slot.fill.startsWith("fill-")).toBe(true);
      expect(slot.bg.startsWith("bg-")).toBe(true);
      expect(slot.text.startsWith("text-")).toBe(true);
    }
  });

  it("leads with blue as the primary data hue, not the action accent", () => {
    expect(CHART_SERIES[0]!.key).toBe("blue");
    expect(CHART_SERIES[0]!.key).not.toBe("accent");
  });

  it("keeps green- and red-family slots non-adjacent (CVD-safe)", () => {
    const family = (key: string) => key.replace(/-deep$/, "");
    for (let i = 0; i < CHART_SERIES.length - 1; i++) {
      const a = family(CHART_SERIES[i]!.key);
      const b = family(CHART_SERIES[i + 1]!.key);
      const pair = new Set([a, b]);
      expect(pair.has("green") && pair.has("red")).toBe(false);
    }
  });
});
