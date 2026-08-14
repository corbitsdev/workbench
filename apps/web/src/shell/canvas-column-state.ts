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
import type { ArtifactRendererKind } from "@corbits/artifact-ui";

/** The canvas's typed-artifact pane: a title, the already-resolved
 * renderer selection (see `@corbits/artifact-ui`'s `resolveArtifactRendererKind`
 * / `resolveRendererKindFromMediaType`), and the content string those
 * renderers read.
 *
 * `canEdit` (CL-5958 phase 2) opts a text-kind ("doc") artifact into
 * `ArtifactTextEditor` instead of the read-only `ArtifactRenderer` —
 * defaults to `false`/absent so every existing caller keeps rendering
 * read-only with zero behavior change. The presence `/update` route's own
 * `asset:*`/"write" grant check is the real security boundary regardless
 * of this flag; `canEdit` only decides which component a capable viewer
 * sees, never whether a write actually lands. */
export type CanvasArtifactContent = {
  readonly id: string;
  readonly title: string;
  readonly rendererKind: ArtifactRendererKind;
  readonly content: string;
  readonly unavailableReason?: string;
  readonly canEdit?: boolean;
};

export type CanvasColumnState = {
  readonly open: boolean;
  /** When set, the canvas shows a ProfileCard for this subject. */
  readonly profile: ProfileSubject | null;
  /** When set, the canvas shows a typed artifact renderer for this
   * content. Mutually exclusive with `profile` — opening one clears the
   * other, matching the mock's single-pane canvas. */
  readonly artifact: CanvasArtifactContent | null;
  /** Canvas-dominant reading mode (mock's `data-canvas="focus"`): the canvas
   * takes over the stage and col2 collapses until focus exits. */
  readonly focus: boolean;
};

export function initialCanvasColumnState(): CanvasColumnState {
  return {
    open: false,
    profile: null,
    artifact: null,
    focus: false,
  };
}

/** Drop profile/artifact and close (workbench switch). */
export function clearCanvasForTenantSwitch(): CanvasColumnState {
  return initialCanvasColumnState();
}

/** Open (or replace) a profile card in the canvas, dropping any open artifact. */
export function openProfileInCanvas(
  state: CanvasColumnState,
  profile: ProfileSubject,
): CanvasColumnState {
  return { ...state, open: true, profile, artifact: null };
}

/** Close profile and collapse canvas — auxiliary content closed internally. */
export function clearProfileInCanvas(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, open: false, profile: null, focus: false };
}

/** Open (or replace) a typed artifact pane in the canvas, dropping any open profile. */
export function openArtifactInCanvas(
  state: CanvasColumnState,
  artifact: CanvasArtifactContent,
): CanvasColumnState {
  return { ...state, open: true, artifact, profile: null };
}

/** Close the artifact pane and collapse canvas. */
export function clearArtifactInCanvas(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, open: false, artifact: null, focus: false };
}

/** Enter canvas-dominant focus (opens the canvas if it was not already). */
export function focusCanvas(state: CanvasColumnState): CanvasColumnState {
  return { ...state, open: true, focus: true };
}

/** Exit focus without closing the canvas — it settles back to the even split. */
export function unfocusCanvas(state: CanvasColumnState): CanvasColumnState {
  return { ...state, focus: false };
}

/** The mock's cycle control (`data-action="canvas-focus"`): toggles between
 * the even split and canvas-dominant focus. A no-op when the canvas has
 * nothing open — there is no content to read full-screen. */
export function toggleCanvasFocus(state: CanvasColumnState): CanvasColumnState {
  if (!state.open) return state;
  return state.focus ? unfocusCanvas(state) : focusCanvas(state);
}

/** Close whatever the canvas is currently showing — profile or artifact —
 * and drop focus. The mock's explicit `data-action="canvas-close"`. */
export function closeCanvasContent(
  state: CanvasColumnState,
): CanvasColumnState {
  if (state.profile !== null) return clearProfileInCanvas(state);
  if (state.artifact !== null) return clearArtifactInCanvas(state);
  return { ...state, open: false, focus: false };
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
