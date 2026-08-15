// When the viewport narrows past a breakpoint the shell withdraws a whole
// column, and anything focused inside it goes with it — a keyboard user who
// was on a page row or the canvas toggle would be left with focus on
// `<body>`, at the top of the document, with no way back but Tab. The rail
// survives every mode, so its active page is where that focus belongs.
//
// The rail item is found by the component library's own `data-slot`, not by
// a ref threaded through `SidebarRail`: the rail renders its buttons itself
// and exposes no per-item ref, and `data-slot` is the contract those pieces
// publish for exactly this kind of reach-in.

import { useEffect, useLayoutEffect, useRef } from "react";

import type { ShellLayoutMode } from "./breakpoints";

const ACTIVE_RAIL_ITEM = '[data-slot="sidebar-rail-item"][aria-current="page"]';

/**
 * Moves focus to the rail's active page when `previouslyFocused` has been
 * torn out of the document. Returns whether it moved focus, so a caller (and
 * a test) can tell a rescue from a no-op.
 */
export function rescueFocusToRail(
  frame: HTMLElement | null,
  previouslyFocused: Element | null,
): boolean {
  if (frame === null) return false;
  if (previouslyFocused === null) return false;
  if (previouslyFocused.isConnected) return false;
  const railItem = frame.querySelector<HTMLElement>(ACTIVE_RAIL_ITEM);
  if (railItem === null) return false;
  railItem.focus();
  return true;
}

/**
 * Watches the layout mode and rescues focus whenever a mode change is what
 * unmounted the focused element. Nothing happens on the first render or on
 * re-renders that leave the mode alone, so an ordinary route change never
 * steals focus.
 */
export function useShellFocusRescue(
  layoutMode: ShellLayoutMode,
  frameRef: { readonly current: HTMLElement | null },
): void {
  const lastFocused = useRef<Element | null>(null);
  const lastMode = useRef<ShellLayoutMode>(layoutMode);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      lastFocused.current = event.target as Element | null;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  useLayoutEffect(() => {
    if (lastMode.current === layoutMode) return;
    lastMode.current = layoutMode;
    rescueFocusToRail(frameRef.current, lastFocused.current);
  }, [layoutMode, frameRef]);
}
