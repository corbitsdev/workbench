import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "cw-rail";
const DEFAULT_WIDTH = 340;
const MIN = 248;
const MAX = 620;
const GALLERY_RESERVE = 360;
const KEYBOARD_STEP = 24;

function clampStatic(px: number): number {
  return Math.max(MIN, Math.min(px, MAX));
}

function readStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number.parseInt(stored, 10);
      if (Number.isFinite(n)) return clampStatic(n);
    }
  } catch {
    // localStorage unavailable — use default.
  }
  return DEFAULT_WIDTH;
}

export interface ResizableRail {
  /** Rail width in px, clamped to [MIN, dynamic max]. */
  width: number;
  /** Lower bound (px) — for aria-valuemin. */
  min: number;
  /** Current upper bound (px), clamped to leave room for the gallery — for aria-valuemax. */
  max: number;
  /** True while a drag is in progress (callers suppress transitions). */
  dragging: boolean;
  /** Attach to the container that spans rail + handle + content. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the drag handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

/**
 * Drag-to-resize the library rail, mirroring workbench.html: pointer drag,
 * double-click to reset, arrow keys to nudge, width persisted to localStorage.
 * The max is clamped to leave room for the gallery (container width - reserve).
 */
export function useResizableRail(): ResizableRail {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [maxWidth, setMaxWidth] = useState<number>(MAX);
  const [dragging, setDragging] = useState(false);

  const dynamicMax = useCallback((): number => {
    const container = containerRef.current;
    return container
      ? Math.min(MAX, container.clientWidth - GALLERY_RESERVE)
      : MAX;
  }, []);

  const setRail = useCallback(
    (px: number) => {
      const max = dynamicMax();
      const clamped = Math.max(MIN, Math.min(px, max));
      setMaxWidth(max);
      setWidth(clamped);
      try {
        localStorage.setItem(STORAGE_KEY, String(clamped));
      } catch {
        // best-effort persistence
      }
    },
    [dynamicMax],
  );

  // Re-clamp the persisted width against the live container size on mount and
  // on viewport resize — the stored value may exceed the current dynamic max.
  useEffect(() => {
    const reclamp = () => setRail(width);
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
    // Run once on mount; setRail/width are stable enough and we don't want a
    // re-clamp loop on every width change (drag already clamps).
  }, []);

  const draggingRef = useRef(false);
  // Cached container left edge for the duration of a drag — invariant while
  // dragging, so we avoid a getBoundingClientRect() layout read per move.
  const dragLeftRef = useRef(0);

  const onPointerDown = useCallback(() => {
    const container = containerRef.current;
    if (container) dragLeftRef.current = container.getBoundingClientRect().left;
    draggingRef.current = true;
    setDragging(true);
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      setRail(e.clientX - dragLeftRef.current);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setRail]);

  const onDoubleClick = useCallback(() => setRail(DEFAULT_WIDTH), [setRail]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        setRail(width - KEYBOARD_STEP);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        setRail(width + KEYBOARD_STEP);
        e.preventDefault();
      }
    },
    [setRail, width],
  );

  return {
    width,
    min: MIN,
    max: maxWidth,
    dragging,
    containerRef,
    handleProps: { onPointerDown, onDoubleClick, onKeyDown },
  };
}
