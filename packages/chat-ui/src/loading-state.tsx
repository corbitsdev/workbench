// The one warm loader every page/room-level wait in this app renders
// (CL-6370, following CL-6307's setup loader) — a bare skeleton/spinner/grey
// slab is never the right answer for "we don't know how long this takes":
// one honest headline plus a small rotating tip reads as useful rather than
// stalled, and it's the same shape everywhere so a reader learns it once.
//
// `delayMs` (default 200) holds the loader itself back: a wait that
// resolves before the delay elapses never gets an intermediate frame at
// all, which is what keeps a fast round-trip from flashing chrome the
// reader has no time to read.

import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "./strings";

const WORKBENCH_LOADING_TIP_INTERVAL_MS = 4000;
const DEFAULT_LOADING_DELAY_MS = 200;

/** A small, honest product tip under the loading headline — rotates on a
 * timer regardless of motion preference; the fade between tips is the
 * only thing `prefers-reduced-motion` turns off (the CSS keyframe is
 * scoped to `no-preference`, so a reduced-motion reader still sees each
 * tip in turn, just without the crossfade). */
function WorkbenchLoadingTip() {
  const tips = CHAT_STRINGS.workbenchLoadingTips;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((current) => (current + 1) % tips.length);
    }, WORKBENCH_LOADING_TIP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tips.length]);

  return (
    <span key={index} className="chat-workbench-loading-tip" aria-live="polite">
      {tips[index]}
    </span>
  );
}

/**
 * The shared page/room-level loading treatment: one honest headline (never
 * an internal stage name — "Starting the runtime…" tells the reader
 * nothing they can act on) plus a rotating tip. Delays its own mount by
 * `delayMs` so a wait that resolves quickly never flashes an intermediate
 * frame — see this file's doc.
 */
export function WorkbenchLoadingState({
  delayMs = DEFAULT_LOADING_DELAY_MS,
  title = CHAT_STRINGS.workbenchLoadingTitle,
  className,
}: {
  readonly delayMs?: number;
  /** Overrides the headline for a surface that isn't the workbench
   * timeline itself (a side panel loading routines or runs, say) — still
   * one honest sentence naming what's loading, never an internal stage. */
  readonly title?: string;
  readonly className?: string;
}) {
  const [visible, setVisible] = useState(delayMs <= 0);

  useEffect(() => {
    // A surface that swaps its own `delayMs` — a route that starts out
    // "still reading" (delayed) and becomes "known to be waiting"
    // (immediate) — reconciles onto this same element rather than
    // remounting it, so dropping to 0 has to show the loader outright.
    // Returning early here instead left the loader hidden for good and
    // rendered the wait as a blank page (CL-6462).
    if (delayMs <= 0) {
      setVisible(true);
      return;
    }
    const id = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);

  if (!visible) return null;

  const classNames = ["chat-workbench-loading"];
  if (className !== undefined) classNames.push(className);

  return (
    <div className={classNames.join(" ")} role="status">
      <span className="chat-workbench-loading-mark" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </span>
      <span className="chat-workbench-loading-title">{title}</span>
      <WorkbenchLoadingTip />
    </div>
  );
}
