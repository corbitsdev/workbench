/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  computeMapTransform,
  hexToRgb,
  markFrame,
  MARK_PERIOD_SECONDS,
  smooth,
} from "./reconnecting-mark-anim";

describe("smooth", () => {
  it("pins the endpoints and midpoint and clamps out-of-range input", () => {
    expect(smooth(0)).toBe(0);
    expect(smooth(1)).toBe(1);
    expect(smooth(0.5)).toBeCloseTo(0.5, 5);
    expect(smooth(-2)).toBe(0);
    expect(smooth(3)).toBe(1);
  });
  it("eases (below the linear line early, above it late)", () => {
    expect(smooth(0.25)).toBeLessThan(0.25);
    expect(smooth(0.75)).toBeGreaterThan(0.75);
  });
});

describe("hexToRgb", () => {
  it("parses the Corbits accent tokens", () => {
    expect(hexToRgb("#bf6b20")).toEqual([191, 107, 32]);
    expect(hexToRgb("#e98428")).toEqual([233, 132, 40]);
  });
  it("expands 3-digit hex and tolerates a missing hash", () => {
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("ffffff")).toEqual([255, 255, 255]);
  });
});

describe("computeMapTransform", () => {
  const vb = { x: 32, y: 115, w: 437, h: 270 };
  it("fits the viewBox at 92% of the limiting dimension", () => {
    const { s } = computeMapTransform(200, 200, vb);
    expect(s).toBeCloseTo((200 / 437) * 0.92, 6); // width-limited
  });
  it("centers the mapped viewBox in the buffer", () => {
    const { s, tx, ty } = computeMapTransform(400, 300, vb);
    // The mapped box's left edge + right edge should be symmetric in the buffer.
    const left = vb.x * s + tx;
    const right = (vb.x + vb.w) * s + tx;
    expect(left + right).toBeCloseTo(400, 4);
    const top = vb.y * s + ty;
    const bottom = (vb.y + vb.h) * s + ty;
    expect(top + bottom).toBeCloseTo(300, 4);
  });
});

describe("markFrame", () => {
  it("is a static full mark under reduced motion", () => {
    expect(markFrame(0, true)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 });
    expect(markFrame(999, true)).toEqual({
      drawProg: 1,
      fillProg: 1,
      alpha: 1,
    });
  });

  it("draws the outline first with no fill", () => {
    const f = markFrame(MARK_PERIOD_SECONDS * 0.2, false);
    expect(f.fillProg).toBe(0);
    expect(f.drawProg).toBeGreaterThan(0);
    expect(f.drawProg).toBeLessThan(1);
    expect(f.alpha).toBe(1);
  });

  it("fills the fully-drawn outline in the fill phase", () => {
    const f = markFrame(MARK_PERIOD_SECONDS * 0.6, false);
    expect(f.drawProg).toBe(1);
    expect(f.fillProg).toBeGreaterThan(0);
    expect(f.fillProg).toBeLessThan(1);
  });

  it("holds the mark full, then fades before the loop restarts", () => {
    expect(markFrame(MARK_PERIOD_SECONDS * 0.82, false)).toEqual({
      drawProg: 1,
      fillProg: 1,
      alpha: 1,
    });
    const fade = markFrame(MARK_PERIOD_SECONDS * 0.97, false);
    expect(fade.fillProg).toBe(1);
    expect(fade.alpha).toBeGreaterThan(0);
    expect(fade.alpha).toBeLessThan(1);
  });

  it("loops on the period (a time past one period maps back into the cycle)", () => {
    // Sampled in the hold-full plateau so the assertion is exact, not subject to
    // float drift in the eased ramps.
    const inHold = MARK_PERIOD_SECONDS * 0.82;
    expect(markFrame(MARK_PERIOD_SECONDS + inHold, false)).toEqual(
      markFrame(inHold, false),
    );
  });
});
