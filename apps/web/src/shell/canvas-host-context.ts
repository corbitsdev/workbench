// The canvas host context object and the types that shape it, apart from
// the provider and hooks around it — see `../bench-context-value.ts` for
// why a `createContext` call never shares a module with a component.

import { createContext } from "react";

import type { ProfileSubject } from "@/chat";
import type { ArtifactRendererKind } from "@/library";
import type { CanvasColumnState } from "@/shell/layout";

/** The canvas's typed-artifact pane: a title, the already-resolved
 * renderer selection (see `@/library`'s `resolveArtifactRendererKind`
 * / `resolveRendererKindFromMediaType`), and the content string those
 * renderers read.
 *
 * `canEdit` (phase 2) opts a text-kind ("doc") artifact into
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
  /** The sandboxed preview route for an `"html"`-kind artifact —
   * see `ArtifactRenderProps.previewSrc`. Absent for every other renderer
   * kind, and for an HTML blob with no Library artifact id to preview. */
  readonly previewSrc?: string;
};

/** The canvas's routine pane subject: which routine to show, or `null` to
 * start a brand-new one. Distinct from `CanvasArtifactContent` — the panel
 * fetches and owns its own routine data (name, instruction, trigger, run
 * history) from `routineId`, the same way `ProfileCanvasPane` fetches
 * shared workbenches from a `ProfileSubject`'s address rather than being
 * handed pre-resolved content. */
export type RoutinePanelSubject = {
  /** Always opens the editor: a specific routine (`routineId` set) or a
   * brand-new one (`routineId` omitted or `null`) — routines-page's own
   * "New routine"/"Edit" actions, "Make this a routine", the composer's
   * `/routine` command, and "New routine in this space" (:
   * browsing/running existing routines moved to the global `/workflows`
   * page, so this pane no longer has a list mode). */
  readonly routineId?: string | null;
  /** Seeds the Name/Instruction fields the instant a brand-new panel opens
   * (`routineId: null` only) — "Make this a routine" (a completed task
   * result) and similar callers with something worth pre-filling. The
   * panel still autosaves on the person's own edits; this only seeds the
   * initial draft. */
  readonly initialName?: string;
  readonly initialInstruction?: string;
  /** The conversation this routine belongs to — its own agent (the
   * workbench's host participant; every workbench's host is Myra) backs the
   * routine, and its own id is where the routine delivers. Carried through
   * list mode too, so "New routine" picked from the list still binds to
   * the workbench the panel was opened beside. Omitted only when there is no
   * open conversation to bind to (e.g. a deliberate `/workflows` visit),
   * in which case the panel falls back to this workbench's own default
   * (Myra) workbench — never mints a new one. */
  readonly workbenchId?: string;
  /** Seeds the target picker's initial selection — the
   * conversation's own single agent participant's definition asset id,
   * when the opener could resolve exactly one. Shown visibly in
   * `DefinitionTargetPicker` and freely replaceable/clearable by the
   * person; only their final explicit pick is ever sent to the backend.
   * Omitted whenever the opener found zero or several candidates, or has
   * no conversation to derive one from at all. */
  readonly preselectedAssetId?: string;
};

/** Workbench's concrete instantiation of `@/shell/layout`'s generic
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

export const CanvasHostContext = createContext<CanvasHost>({
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
