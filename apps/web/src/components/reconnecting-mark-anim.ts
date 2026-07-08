/**
 * Pure animation math for the reconnecting mark, split out from the canvas
 * plumbing so the parts that actually carry behavior — the draw/fill timeline,
 * theme-color parsing, and the viewBox→buffer fit — are unit-testable. The
 * canvas wiring in ReconnectingOverlay only orchestrates these.
 */

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smoothstep easing, clamped to [0, 1]. */
export function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Parse a `#rgb` / `#rrggbb` color (theme token) into an RGB triple. */
export function hexToRgb(c: string): [number, number, number] {
  let s = c.trim().replace("#", "");
  if (s.length === 3)
    s = s
      .split("")
      .map((x) => x + x)
      .join("");
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Fit the mark's viewBox into a `bw x bh` buffer, centered, at 92% scale. */
export function computeMapTransform(
  bw: number,
  bh: number,
  vb: ViewBox,
): { s: number; tx: number; ty: number } {
  const s = Math.min(bw / vb.w, bh / vb.h) * 0.92;
  return {
    s,
    tx: (bw - vb.w * s) / 2 - vb.x * s,
    ty: (bh - vb.h * s) / 2 - vb.y * s,
  };
}

export interface MarkFrame {
  /** 0..1 length of the dithered outline currently drawn. */
  drawProg: number;
  /** 0..1 bottom-up fill of the silhouette. */
  fillProg: number;
  /** 0..1 overall opacity (fades out before the loop restarts). */
  alpha: number;
}

export const MARK_PERIOD_SECONDS = 4.6;

/**
 * The looping timeline: draw the outline in (0–38%), hold (38–48%), fill
 * bottom-up (48–76%), hold full (76–90%), fade out (90–100%), then repeat. With
 * `still` (reduced motion) it is a static, fully-drawn, fully-filled mark.
 */
export function markFrame(t: number, still: boolean): MarkFrame {
  if (still) return { drawProg: 1, fillProg: 1, alpha: 1 };
  const p = (t % MARK_PERIOD_SECONDS) / MARK_PERIOD_SECONDS;
  if (p < 0.38) return { drawProg: smooth(p / 0.38), fillProg: 0, alpha: 1 };
  if (p < 0.48) return { drawProg: 1, fillProg: 0, alpha: 1 };
  if (p < 0.76)
    return { drawProg: 1, fillProg: smooth((p - 0.48) / 0.28), alpha: 1 };
  if (p < 0.9) return { drawProg: 1, fillProg: 1, alpha: 1 };
  return { drawProg: 1, fillProg: 1, alpha: smooth((1 - p) / 0.1) };
}
