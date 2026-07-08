import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  CORBITS_MARK_PATH,
  CORBITS_MARK_VIEWBOX as VB,
  CorbitsMark,
} from "./corbits-mark";
import {
  computeMapTransform,
  hexToRgb,
  markFrame,
} from "./reconnecting-mark-anim";

// 8x8 ordered Bayer matrix — the same one the auth DitherBackground uses, so the
// mark shimmers in the house dither style.
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
const CELL = 3; // device px per dither cell before upscaling
const STROKE_W = 8; // dithered line width, in viewBox units

const OVERLAY_MESSAGE_ID = "reconnecting-overlay-message";

/**
 * Animates the Corbits mark: a Bayer-dithered line draws the mountain in, then
 * the silhouette fills bottom-up into a shimmering dithered fill, and loops. The
 * two accent tones are read from the app's theme tokens (once, refreshed on a
 * theme switch — not every frame), so the mark re-tints with the active
 * Workbench theme. Honors `prefers-reduced-motion` with a static filled mark.
 * All work is skipped when a 2D context is unavailable.
 */
function useDitherMark(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    const mask = document.createElement("canvas");
    const maskCtx = mask.getContext("2d");
    if (!offCtx || !maskCtx) return;

    const p2d = new Path2D(CORBITS_MARK_PATH);
    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const readTones = (): [
      [number, number, number],
      [number, number, number],
    ] => {
      const cs = getComputedStyle(canvas);
      const a = cs.getPropertyValue("--accent").trim() || "#bf6b20";
      const b = cs.getPropertyValue("--accent-soft").trim() || "#d98f4a";
      return [hexToRgb(a), hexToRgb(b)];
    };
    // Colors only change on a theme switch, so read them once and refresh on a
    // data-theme mutation rather than calling getComputedStyle every frame.
    let tones = readTones();
    const themeObserver = new MutationObserver(() => {
      tones = readTones();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    let bw = 1;
    let bh = 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      bw = Math.max(1, Math.round(r.width / CELL));
      bh = Math.max(1, Math.round(r.height / CELL));
      for (const c of [canvas, off, mask]) {
        c.width = bw;
        c.height = bh;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const mapTransform = () => computeMapTransform(bw, bh, VB);

    const renderField = (t: number, still: boolean) => {
      const [a, b] = tones;
      const img = offCtx.createImageData(bw, bh);
      const d = img.data;
      for (let y = 0; y < bh; y++) {
        const row = (y & 7) * 8;
        for (let x = 0; x < bw; x++) {
          const u = x / bw;
          const v = y / bh;
          const wave = still
            ? 0.6
            : 0.5 + 0.5 * Math.sin((u + v) * 5.0 - t * 1.6);
          const thr = (BAYER[row + (x & 7)]! + 0.5) / 64;
          const c = wave > thr ? b : a;
          const i = (y * bw + x) * 4;
          d[i] = c[0];
          d[i + 1] = c[1];
          d[i + 2] = c[2];
          d[i + 3] = 255;
        }
      }
      offCtx.putImageData(img, 0, 0);
    };

    const renderMask = (drawProg: number, fillProg: number) => {
      const { s, tx, ty } = mapTransform();
      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.clearRect(0, 0, bw, bh);
      maskCtx.fillStyle = "#fff";
      maskCtx.strokeStyle = "#fff";
      maskCtx.lineJoin = "round";
      maskCtx.lineCap = "round";

      if (fillProg > 0) {
        maskCtx.save();
        const cutY = bh * (1 - fillProg);
        maskCtx.beginPath();
        maskCtx.rect(0, cutY, bw, bh - cutY);
        maskCtx.clip();
        maskCtx.setTransform(s, 0, 0, s, tx, ty);
        maskCtx.fill(p2d);
        maskCtx.restore();
      }
      if (drawProg > 0 && fillProg < 1) {
        maskCtx.save();
        maskCtx.setTransform(s, 0, 0, s, tx, ty);
        maskCtx.lineWidth = STROKE_W;
        maskCtx.setLineDash([1000 * drawProg, 100000]);
        maskCtx.stroke(p2d);
        maskCtx.restore();
        maskCtx.setLineDash([]);
      }
    };

    // The stroke uses a normalized dash (the mask's Path2D has no measurable
    // length via getTotalLength), so drawProg 0..1 maps onto a large dash window.
    let raf = 0;
    let lastAlpha = -1;
    const start = performance.now();
    const frame = (now: number) => {
      const still = reduceQuery.matches;
      const t = (now - start) / 1000;
      const { drawProg, fillProg, alpha } = markFrame(t, still);
      renderField(t, still);
      renderMask(drawProg, fillProg);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(off, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (alpha !== lastAlpha) {
        canvas.style.opacity = String(alpha);
        lastAlpha = alpha;
      }
      if (still) return; // one static frame; no loop
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onReduceChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };
    reduceQuery.addEventListener("change", onReduceChange);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      reduceQuery.removeEventListener("change", onReduceChange);
    };
  }, [canvasRef]);
}

/**
 * Full-screen cover shown while the app reconnects to a restarting hub/sidecar.
 * Styled entirely through the app's theme tokens (no palette of its own), so it
 * always matches the user's active Workbench theme. Fades in/out via the
 * AnimatePresence in ConnectionStatusProvider.
 */
export function ReconnectingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useDitherMark(canvasRef);

  return (
    <motion.div
      role="status"
      aria-labelledby={OVERLAY_MESSAGE_ID}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="fixed inset-0 z-[100] bg-page"
    >
      <div className="absolute left-7 top-6 flex items-center gap-[9px]">
        <CorbitsMark className="h-[17px] w-[22px] text-accent" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-2">
          Corbits Workbench
        </span>
      </div>

      <div className="absolute inset-0 flex items-center justify-center p-6">
        <p
          id={OVERLAY_MESSAGE_ID}
          className="max-w-[32ch] text-center text-xs leading-relaxed text-text-3"
        >
          Updating Workbench
        </p>
      </div>

      <div className="absolute bottom-6 left-7">
        <span className="font-mono text-[11.5px] tabular-nums tracking-wide text-text-3">
          v{__APP_VERSION__}
        </span>
      </div>

      <div className="absolute bottom-[22px] right-[26px] h-[70px] w-[92px]">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="h-full w-full [image-rendering:pixelated]"
        />
      </div>
    </motion.div>
  );
}
