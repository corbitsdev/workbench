// The canvas host context object and the types that shape it, apart from
// the provider and hooks around it — see `../bench-context-value.ts` for
// why a `createContext` call never shares a module with a component.

import { createContext } from "react";

import type { ProfileSubject } from "@/chat";
import type { ArtifactRendererKind } from "@/library";
import type { CanvasColumnState } from "@/shell/layout";

// `canEdit` only picks the component; the `/update` route's own grant
// check is the real security boundary regardless of this flag.
export type CanvasArtifactContent = {
  readonly id: string;
  readonly title: string;
  readonly rendererKind: ArtifactRendererKind;
  readonly content: string;
  readonly unavailableReason?: string;
  readonly canEdit?: boolean;
  // Absent for every renderer but html, and for a blob with no artifact id.
  readonly previewSrc?: string;
};

// Distinct from `CanvasArtifactContent`: the panel fetches and owns its
// own routine data from `routineId` rather than being handed content.
export type RoutinePanelSubject = {
  readonly routineId?: string | null;
  // Seeds the Name/Instruction fields on a brand-new panel only; the panel
  // still autosaves on the person's own edits after that.
  readonly initialName?: string;
  readonly initialInstruction?: string;
  // Omitted only with no open conversation to bind to, in which case the
  // panel falls back to this workbench's own default (Myra) — never mints
  // a new one.
  readonly workbenchId?: string;
  // The opener's single resolved agent participant, when there was
  // exactly one; freely replaceable, only the person's final pick is sent.
  readonly preselectedAssetId?: string;
};

// A `ProfileSubject` for the profile pane, `CanvasArtifactContent` for the
// artifact pane, `RoutinePanelSubject` for the routine pane.
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
