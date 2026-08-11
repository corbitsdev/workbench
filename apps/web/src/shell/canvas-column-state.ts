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
};

export function initialCanvasColumnState(): CanvasColumnState {
  return {
    open: false,
    profile: null,
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
  return { ...state, open: false, profile: null };
}

/** What actually renders: demand-driven open state, gated by whether the
 *  current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}
