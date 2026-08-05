import { useEffect, useRef } from "react";

// 8x8 ordered Bayer threshold matrix (same as the corbits dither shader).
// prettier-ignore
const BAYER = [
   0,32, 8,40, 2,34,10,42,
  48,16,56,24,50,18,58,26,
  12,44, 4,36,14,46, 6,38,
  60,28,52,20,62,30,54,22,
   3,35,11,43, 1,33, 9,41,
  51,19,59,27,49,17,57,25,
  15,47, 7,39,13,45, 5,37,
  63,31,55,23,61,29,53,21,
];
const BAYER_DIM = 8; // matrix is BAYER_DIM x BAYER_DIM
const BAYER_DIVISOR = BAYER_DIM * BAYER_DIM; // threshold normalization range
const LEVELS = 4; // quantization levels per channel
const CELL = 4; // device px per dither cell once upscaled (matches corbits)
const AMBIENT_PX = 1.6; // ambient warp amplitude (source px)
const MOUSE_PX = 5; // mouse warp amplitude (source px)
const MOUSE_FALLOFF = 18; // gaussian tightness of the cursor displacement
const MOUSE_LERP = 0.1; // cursor position easing per frame
const STRENGTH_LERP = 0.08; // cursor influence easing per frame
const FRAME_MS = 1000 / 30; // animation cap (~30fps) to spare the CPU
const ASSET = "/images/hero-dither.png"; // same-origin source image

/**
 * Animated ordered-dither over a source image, rendered on a 2D canvas. A
 * downscaled buffer is dithered each frame with a slow ambient sine warp plus a
 * cursor-driven displacement, then upscaled with `image-rendering: pixelated`.
 *
 * This replaces the original WebGL port: a WebGL canvas promoted the auth
 * panel to a GPU-composited layer that failed to paint (blank/white). A 2D
 * canvas is CPU-rasterized, composites reliably, and retains its last frame
 * when requestAnimationFrame is paused on a hidden tab.
 *
 * The loop is paused whenever the canvas is offscreen or the tab is hidden, is
 * capped to ~30fps, and honours `prefers-reduced-motion` reactively (a single
 * static frame, re-evaluated when the OS setting toggles).
 */
export function DitherBackground({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    if (!offCtx) return;

    let disposed = false;
    let w = 1;
    let h = 1;
    let srcPx: Uint8ClampedArray | null = null;
    let dest: ImageData | null = null;
    let imgLoaded = false;
    // Per-frame sine tables, reallocated only on resize.
    let su = new Float32Array(1);
    let su2 = new Float32Array(1);
    let sv = new Float32Array(1);
    let sv2 = new Float32Array(1);

    const img = new Image();

    const resample = () => {
      if (!imgLoaded) return;
      off.width = w;
      off.height = h;
      const ir = img.naturalWidth / img.naturalHeight;
      const cr = w / h;
      let dw = w;
      let dh = h;
      if (cr > ir) {
        dh = w / ir;
      } else {
        dw = h * ir;
      }
      offCtx.clearRect(0, 0, w, h);
      offCtx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      srcPx = offCtx.getImageData(0, 0, w, h).data;
      dest = ctx.createImageData(w, h);
    };

    const resize = () => {
      w = Math.max(1, Math.round(canvas.clientWidth / CELL));
      h = Math.max(1, Math.round(canvas.clientHeight / CELL));
      canvas.width = w;
      canvas.height = h;
      su = new Float32Array(w);
      su2 = new Float32Array(w);
      sv = new Float32Array(h);
      sv2 = new Float32Array(h);
      resample();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let mx = 0.5;
    let my = 0.5;
    let tmx = 0.5;
    let tmy = 0.5;
    let mStr = 0;
    let tStr = 0;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      tmx = (e.clientX - r.left) / r.width;
      tmy = (e.clientY - r.top) / r.height;
      const inside = tmx > -0.1 && tmx < 1.1 && tmy > -0.1 && tmy < 1.1;
      tStr = inside ? 1 : 0;
    };
    // Listen on window, not the canvas: the canvas is painted behind the
    // QuoteCard overlay, so canvas-scoped pointermove never fires. onMove
    // already maps coordinates to the canvas rect and zeroes strength when
    // the cursor is outside the panel, so the global listener is cheap.
    window.addEventListener("pointermove", onMove, { passive: true });

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = reduceQuery.matches;

    const render = (t: number) => {
      if (!srcPx || !dest) return;
      const d = dest.data;
      const aspect = w / h;
      const amb = reduce ? 0 : AMBIENT_PX;
      const mamp = reduce ? 0 : MOUSE_PX;
      // Separable sine tables keep the warp to O(w+h) trig calls per frame.
      for (let x = 0; x < w; x++) {
        const u = x / w;
        su[x] = Math.sin(u * 6.2 + t * 0.6);
        su2[x] = Math.sin(u * 9.1 + t * 0.27);
      }
      for (let y = 0; y < h; y++) {
        const v = y / h;
        sv[y] = Math.sin(v * 5.3 - t * 0.5);
        sv2[y] = Math.sin(v * 8.4 + t * 0.4);
      }
      const useMouse = mStr > 0.01;
      // Every index below is in range by construction (the tables are sized
      // w/h and sx/sy are clamped); the `?? 0` coalesces only satisfy
      // noUncheckedIndexedAccess and never fire.
      for (let y = 0; y < h; y++) {
        const v = y / h;
        const rowBayer = (y & 7) * BAYER_DIM;
        const svy = sv[y] ?? 0;
        const sv2y = sv2[y] ?? 0;
        for (let x = 0; x < w; x++) {
          let wx = ((su[x] ?? 0) + sv2y) * amb;
          let wy = (svy + (su2[x] ?? 0)) * amb;
          if (useMouse) {
            const ddx = x / w - mx;
            const ddy = v - my;
            const dist = Math.sqrt(ddx * ddx * aspect * aspect + ddy * ddy);
            const infl = Math.exp(-dist * dist * MOUSE_FALLOFF) * mStr;
            const inv = 1 / (dist + 1e-4);
            wx += ddx * inv * infl * mamp;
            wy += ddy * inv * infl * mamp;
          }
          let sx = x + Math.round(wx);
          let sy = y + Math.round(wy);
          if (sx < 0) sx = 0;
          else if (sx >= w) sx = w - 1;
          if (sy < 0) sy = 0;
          else if (sy >= h) sy = h - 1;
          const si = (sy * w + sx) * 4;
          const di = (y * w + x) * 4;
          const thr = ((BAYER[rowBayer + (x & 7)] ?? 0) + 0.5) / BAYER_DIVISOR;
          for (let c = 0; c < 3; c++) {
            const q = Math.floor(
              ((srcPx[si + c] ?? 0) / 255) * (LEVELS - 1) + thr,
            );
            d[di + c] = (q / (LEVELS - 1)) * 255;
          }
          d[di + 3] = 255;
        }
      }
      ctx.putImageData(dest, 0, 0);
    };

    let visible = true;
    const running = () => !disposed && !reduce && visible && !document.hidden;

    let raf = 0;
    let lastDraw = 0;
    const start = performance.now();
    const frame = (now: number) => {
      raf = 0;
      if (!running()) return;
      if (now - lastDraw >= FRAME_MS) {
        lastDraw = now;
        mx += (tmx - mx) * MOUSE_LERP;
        my += (tmy - my) * MOUSE_LERP;
        mStr += (tStr - mStr) * STRENGTH_LERP;
        render((now - start) / 1000);
      }
      schedule();
    };
    const schedule = () => {
      if (raf || !running()) return;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
        if (visible) schedule();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) stop();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onReduceChange = () => {
      reduce = reduceQuery.matches;
      if (reduce) {
        stop();
        render(0);
      } else {
        schedule();
      }
    };
    reduceQuery.addEventListener("change", onReduceChange);

    img.onload = () => {
      if (disposed) return;
      imgLoaded = true;
      resample();
      render(0);
      schedule();
    };
    img.src = ASSET;

    return () => {
      disposed = true;
      stop();
      img.onload = null;
      img.src = "";
      ro.disconnect();
      io.disconnect();
      reduceQuery.removeEventListener("change", onReduceChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        imageRendering: "pixelated",
      }}
    />
  );
}
