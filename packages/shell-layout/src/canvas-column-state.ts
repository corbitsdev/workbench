// The canvas column's state as pure transitions, separate from
// `breakpoints.ts`'s allow/disallow rule — profile demand and the viewport's
// veto are independent inputs; `resolveCanvasVisibility` is the one place
// they combine.
//
// Canvas is auxiliary only (profiles and similar targeted surfaces). Primary
// channel conversation lives in the main stage via route (`/`, `/c`, `/c/:id`).
// There is no permanent toggle: canvas opens when auxiliary content is targeted
// and closes when that content is dismissed.
//
// `TProfile` is whatever subject the host app's canvas renders (a
// ProfileCard subject, or anything else worth targeting) — this module owns
// only the open/focus transitions, never the shape of what's shown.

export type CanvasColumnState<TProfile> = {
  readonly open: boolean;
  /** When set, the canvas shows content for this subject. */
  readonly profile: TProfile | null;
  /** Canvas-dominant reading mode (mock's `data-canvas="focus"`): the canvas
   * takes over the stage and col2 collapses until focus exits. No caller
   * enters this mode yet — CL-5936 wires the transitions so a canvas-focus
   * trigger only has to call `focusCanvas`/`unfocusCanvas` when it lands. */
  readonly focus: boolean;
};

export function initialCanvasColumnState<
  TProfile,
>(): CanvasColumnState<TProfile> {
  return {
    open: false,
    profile: null,
    focus: false,
  };
}

/** Drop profile and close (workbench switch). */
export function clearCanvasForTenantSwitch<
  TProfile,
>(): CanvasColumnState<TProfile> {
  return initialCanvasColumnState<TProfile>();
}

/** Open (or replace) a profile card in the canvas. */
export function openProfileInCanvas<TProfile>(
  state: CanvasColumnState<TProfile>,
  profile: TProfile,
): CanvasColumnState<TProfile> {
  return { ...state, open: true, profile };
}

/** Close profile and collapse canvas — auxiliary content closed internally. */
export function clearProfileInCanvas<TProfile>(
  state: CanvasColumnState<TProfile>,
): CanvasColumnState<TProfile> {
  return { ...state, open: false, profile: null, focus: false };
}

/** Enter canvas-dominant focus (opens the canvas if it was not already). */
export function focusCanvas<TProfile>(
  state: CanvasColumnState<TProfile>,
): CanvasColumnState<TProfile> {
  return { ...state, open: true, focus: true };
}

/** Exit focus without closing the canvas — it settles back to the even split. */
export function unfocusCanvas<TProfile>(
  state: CanvasColumnState<TProfile>,
): CanvasColumnState<TProfile> {
  return { ...state, focus: false };
}

/** What actually renders: demand-driven open state, gated by whether the
 *  current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility<TProfile>(
  state: CanvasColumnState<TProfile>,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}

/** Whether the canvas is in its dominant focus mode right now — the one
 * input col2's width state needs from canvas at all (see `stage-chrome.ts`'s
 * `deriveCol2Width`). */
export function resolveCanvasFocus<TProfile>(
  state: CanvasColumnState<TProfile>,
  allowed: boolean,
): boolean {
  return state.open && state.focus && allowed;
}
