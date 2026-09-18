// `delayMs` (default 200) holds the loader back so a fast round-trip
// never flashes chrome the reader has no time to read.

import { CorbitsMark } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "./strings";

const WORKBENCH_LOADING_TIP_INTERVAL_MS = 4000;
const DEFAULT_LOADING_DELAY_MS = 200;

// Rotates regardless of motion preference; only the crossfade is scoped
// to `no-preference` and turns off under `prefers-reduced-motion`.
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

// Headline is always one honest sentence, never an internal stage name.
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
    // A route swapping `delayMs` to 0 reconciles onto this same element;
    // returning early here instead left the loader hidden and the wait
    // rendered as a blank page.
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
      <CorbitsMark decorative className="chat-workbench-loading-brand" />
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
