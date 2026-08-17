// Canvas host surface for stage content: whether the shell has room for the
// fourth column, how main-stage chat opens auxiliary canvas content
// (profiles, artifacts) without owning the canvas column itself, and — for
// AppShell's own render, which no longer owns this state — what the canvas
// column is actually showing right now.

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@corbits/chat-ui";
import type { ArtifactRendererKind } from "@corbits/artifact-ui";
import type { CanvasColumnState } from "@corbits/shell-layout";

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
  /** The sandboxed preview route for an `"html"`-kind artifact (CL-5879) —
   * see `ArtifactRenderProps.previewSrc`. Absent for every other renderer
   * kind, and for an HTML blob with no Library artifact id to preview. */
  readonly previewSrc?: string;
};

/** The canvas's routine pane subject: which routine to show, or `null` to
 * start a brand-new one. Distinct from `CanvasArtifactContent` — the panel
 * fetches and owns its own routine data (name, instruction, trigger, run
 * history) from `routineId`, the same way `ProfileCanvasPane` fetches
 * shared channels from a `ProfileSubject`'s address rather than being
 * handed pre-resolved content. */
export type RoutinePanelSubject = {
  /** Opens straight to the panel's default list view — the workbench's
   * active routines, with a "New routine" row at the top — instead of a
   * specific routine's editor. The header's Routines affordance and the
   * `/run` composer command both open this; `routineId` is ignored when
   * present. Omitted (or a `routineId` given instead) opens the editor
   * directly, the same way every pre-existing caller (routines-page's own
   * "New routine"/"Edit" actions, "Make this a routine") already does. */
  readonly view?: "list" | "runs";
  readonly routineId?: string | null;
  /** Seeds the Name/Instruction fields the instant a brand-new panel opens
   * (`routineId: null` only) — "Make this a routine" (a completed task
   * result) and similar callers with something worth pre-filling. The
   * panel still autosaves on the person's own edits; this only seeds the
   * initial draft. */
  readonly initialName?: string;
  readonly initialInstruction?: string;
  /** The conversation this routine belongs to — its own agent (the
   * channel's host participant; every workbench's host is Myra) backs the
   * routine, and its own id is where the routine delivers. Carried through
   * list mode too, so "New routine" picked from the list still binds to
   * the channel the panel was opened beside. Omitted only when there is no
   * open conversation to bind to (e.g. a deliberate `/routines` visit),
   * in which case the panel falls back to this workbench's own default
   * (Myra) channel — never mints a new one. */
  readonly channelId?: string;
};

/** Workbench's concrete instantiation of `@corbits/shell-layout`'s generic
 * canvas state — a `ProfileSubject` for the profile pane, this app's own
 * `CanvasArtifactContent` for the artifact pane, `RoutinePanelSubject` for
 * the routine pane. */
export type AppCanvasColumnState = CanvasColumnState<
  ProfileSubject,
  CanvasArtifactContent,
  RoutinePanelSubject
>;

export type CanvasHost = {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly routine: RoutinePanelSubject | null;
  readonly focus: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly openArtifact: (artifact: CanvasArtifactContent) => void;
  readonly openRoutine: (subject: RoutinePanelSubject) => void;
  readonly toggleFocus: () => void;
  /** Closes whichever content the canvas currently shows (profile,
   * artifact, or routine) and drops focus — one seam regardless of what's
   * open. */
  readonly close: () => void;
};

const CanvasHostContext = createContext<CanvasHost>({
  allowed: false,
  open: false,
  profile: null,
  artifact: null,
  routine: null,
  focus: false,
  openProfile: () => undefined,
  openArtifact: () => undefined,
  openRoutine: () => undefined,
  toggleFocus: () => undefined,
  close: () => undefined,
});

export function CanvasAvailabilityProvider({
  allowed,
  open,
  profile,
  artifact,
  routine,
  focus,
  openProfile,
  openArtifact,
  openRoutine,
  toggleFocus,
  close,
  children,
}: {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly routine: RoutinePanelSubject | null;
  readonly focus: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly openArtifact: (artifact: CanvasArtifactContent) => void;
  readonly openRoutine: (subject: RoutinePanelSubject) => void;
  readonly toggleFocus: () => void;
  readonly close: () => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasHostContext.Provider
      value={{
        allowed,
        open,
        profile,
        artifact,
        routine,
        focus,
        openProfile,
        openArtifact,
        openRoutine,
        toggleFocus,
        close,
      }}
    >
      {children}
    </CanvasHostContext.Provider>
  );
}

export function useCanvasColumnAvailable(): boolean {
  return useContext(CanvasHostContext).allowed;
}

/** Whether the canvas column is actually showing right now — AppShell's own
 * read for the `CanvasColumn`'s `open` prop. */
export function useCanvasColumnOpen(): boolean {
  return useContext(CanvasHostContext).open;
}

/** The subject the canvas column is showing, if any — AppShell's own read
 * for the `CanvasColumn`'s `profile` prop. */
export function useCanvasColumnProfile(): ProfileSubject | null {
  return useContext(CanvasHostContext).profile;
}

/** The typed artifact content the canvas column is showing, if any —
 * AppShell's own read for the `CanvasColumn`'s `artifact` prop. */
export function useCanvasColumnArtifact(): CanvasArtifactContent | null {
  return useContext(CanvasHostContext).artifact;
}

/** The routine pane subject the canvas column is showing, if any —
 * AppShell's own read for the `CanvasColumn`'s `routine` prop. */
export function useCanvasColumnRoutine(): RoutinePanelSubject | null {
  return useContext(CanvasHostContext).routine;
}

/** Whether the canvas is in its dominant focus mode right now. */
export function useCanvasColumnFocus(): boolean {
  return useContext(CanvasHostContext).focus;
}

export function useOpenProfileInCanvas(): (subject: ProfileSubject) => void {
  return useContext(CanvasHostContext).openProfile;
}

/** Opens (or replaces) the canvas's typed artifact pane — the seam a chat
 * artifact chip or the Library page's "open in canvas" affordance calls. */
export function useOpenArtifactInCanvas(): (
  artifact: CanvasArtifactContent,
) => void {
  return useContext(CanvasHostContext).openArtifact;
}

/** Opens (or replaces) the canvas's routine pane — the workbench header's
 * "New routine" action, the `/routines` page's own create button, and an
 * existing routine's own "Edit" hop all call this. `routineId: null` starts
 * a brand-new routine; a real id opens that routine for editing. */
export function useOpenRoutineInCanvas(): (
  subject: RoutinePanelSubject,
) => void {
  return useContext(CanvasHostContext).openRoutine;
}

/** Toggles canvas-dominant focus — the mock's `data-action="canvas-focus"`
 * cycle control. A no-op when the canvas has nothing open. */
export function useToggleCanvasFocus(): () => void {
  return useContext(CanvasHostContext).toggleFocus;
}

/** Closes whatever auxiliary content the canvas is currently showing — the
 * command palette's "Close canvas" action, and the canvas pane's own close
 * button, both use this same seam. */
export function useCloseCanvas(): () => void {
  return useContext(CanvasHostContext).close;
}
