// The canvas column's state as pure transitions, separate from
// `breakpoints.ts`'s allow/disallow rule — profile demand and the viewport's
// veto are independent inputs; `resolveCanvasVisibility` is the one place
// they combine.
//
// Canvas is auxiliary only (profiles and similar targeted surfaces). Primary
// channel conversation lives in the main stage via route (`/`, `/c`, `/c/:id`).
// There is no permanent toggle: canvas opens when auxiliary content is targeted
// and closes when that content is dismissed.

import type { ProfileSubject } from "@corbits/chat-ui";

export type CanvasColumnState = {
  readonly open: boolean;
  /** When set, the canvas shows a ProfileCard for this subject. */
  readonly profile: ProfileSubject | null;
  /** Canvas-dominant reading mode (mock's `data-canvas="focus"`): the canvas
   * takes over the stage and col2 collapses until focus exits. No caller
   * enters this mode yet — CL-5936 wires the transitions so a canvas-focus
   * trigger only has to call `focusCanvas`/`unfocusCanvas` when it lands. */
  readonly focus: boolean;
};

export function initialCanvasColumnState(): CanvasColumnState {
  return {
    open: false,
    profile: null,
    focus: false,
  };
}

/** Drop profile and close (workbench switch). */
export function clearCanvasForTenantSwitch(): CanvasColumnState {
  return initialCanvasColumnState();
}

/** Open (or replace) a profile card in the canvas. */
export function openProfileInCanvas(
  state: CanvasColumnState,
  profile: ProfileSubject,
): CanvasColumnState {
  return { ...state, open: true, profile };
}

/** Close profile and collapse canvas — auxiliary content closed internally. */
export function clearProfileInCanvas(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, open: false, profile: null, focus: false };
}

/** Enter canvas-dominant focus (opens the canvas if it was not already). */
export function focusCanvas(state: CanvasColumnState): CanvasColumnState {
  return { ...state, open: true, focus: true };
}

/** Exit focus without closing the canvas — it settles back to the even split. */
export function unfocusCanvas(state: CanvasColumnState): CanvasColumnState {
  return { ...state, focus: false };
}

/** What actually renders: demand-driven open state, gated by whether the
 *  current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}

/** Whether the canvas is in its dominant focus mode right now — the one
 * input col2's width state needs from canvas at all (see `stage-chrome.ts`'s
 * `deriveCol2Width`). */
export function resolveCanvasFocus(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && state.focus && allowed;
}
