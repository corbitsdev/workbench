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
// ProfileCard subject, or anything else worth targeting); `TArtifact` is
// whatever typed content pane the host renders alongside it (a document, a
// sheet, or anything else); `TRoutine` is a third, equally exclusive slot
// for a routine editor/detail pane. This module owns only the open/focus/
// mutual-exclusion transitions, never the shape of what's shown.

export type CanvasColumnState<TProfile, TArtifact, TRoutine> = {
  readonly open: boolean;
  /** When set, the canvas shows content for this subject. */
  readonly profile: TProfile | null;
  /** When set, the canvas shows a typed artifact pane for this content.
   * Mutually exclusive with `profile`/`routine` — opening one clears the
   * other two. */
  readonly artifact: TArtifact | null;
  /** When set, the canvas shows the routine editor/detail pane. Mutually
   * exclusive with `profile`/`artifact` — opening one clears the other
   * two. */
  readonly routine: TRoutine | null;
  /** Canvas-dominant reading mode (mock's `data-canvas="focus"`): the canvas
   * takes over the stage and col2 collapses until focus exits. */
  readonly focus: boolean;
};

export function initialCanvasColumnState<
  TProfile,
  TArtifact,
  TRoutine,
>(): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return {
    open: false,
    profile: null,
    artifact: null,
    routine: null,
    focus: false,
  };
}

/** Drop profile/artifact/routine and close (workbench switch). */
export function clearCanvasForTenantSwitch<
  TProfile,
  TArtifact,
  TRoutine,
>(): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return initialCanvasColumnState<TProfile, TArtifact, TRoutine>();
}

/** Open (or replace) a profile card in the canvas, dropping any open artifact
 * or routine pane. */
export function openProfileInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
  profile: TProfile,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: true, profile, artifact: null, routine: null };
}

/** Close profile and collapse canvas — auxiliary content closed internally. */
export function clearProfileInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: false, profile: null, focus: false };
}

/** Open (or replace) a typed artifact pane in the canvas, dropping any open
 * profile or routine pane. */
export function openArtifactInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
  artifact: TArtifact,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: true, artifact, profile: null, routine: null };
}

/** Close the artifact pane and collapse canvas. */
export function clearArtifactInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: false, artifact: null, focus: false };
}

/** Open (or replace) the routine editor/detail pane in the canvas, dropping
 * any open profile or artifact. */
export function openRoutineInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
  routine: TRoutine,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: true, routine, profile: null, artifact: null };
}

/** Close the routine pane and collapse canvas. */
export function clearRoutineInCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: false, routine: null, focus: false };
}

/** Enter canvas-dominant focus (opens the canvas if it was not already). */
export function focusCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, open: true, focus: true };
}

/** Exit focus without closing the canvas — it settles back to the even split. */
export function unfocusCanvas<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  return { ...state, focus: false };
}

/** The mock's cycle control (`data-action="canvas-focus"`): toggles between
 * the even split and canvas-dominant focus. A no-op when the canvas has
 * nothing open — there is no content to read full-screen. */
export function toggleCanvasFocus<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  if (!state.open) return state;
  return state.focus ? unfocusCanvas(state) : focusCanvas(state);
}

/** Close whatever the canvas is currently showing — profile, artifact, or
 * routine — and drop focus. The mock's explicit `data-action="canvas-close"`. */
export function closeCanvasContent<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
): CanvasColumnState<TProfile, TArtifact, TRoutine> {
  if (state.profile !== null) return clearProfileInCanvas(state);
  if (state.artifact !== null) return clearArtifactInCanvas(state);
  if (state.routine !== null) return clearRoutineInCanvas(state);
  return { ...state, open: false, focus: false };
}

/** What actually renders: demand-driven open state, gated by whether the
 *  current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}

/** Whether the canvas is in its dominant focus mode right now — the one
 * input col2's width state needs from canvas at all (see `stage-chrome.ts`'s
 * `deriveCol2Width`). */
export function resolveCanvasFocus<TProfile, TArtifact, TRoutine>(
  state: CanvasColumnState<TProfile, TArtifact, TRoutine>,
  allowed: boolean,
): boolean {
  return state.open && state.focus && allowed;
}
