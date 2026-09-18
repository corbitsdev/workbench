// Generic shell mechanics a second Interchange deployment would need.
// Route tables and app-specific policy stay in the consuming app.

export {
  canvasColumnAllowed,
  COMPACT_MAX_WIDTH,
  NARROW_MAX_WIDTH,
  shellLayoutModeForWidth,
  shellLayoutModeFromMatches,
} from "./breakpoints";
export type { ShellLayoutMode } from "./breakpoints";

export { useShellLayoutMode } from "./use-shell-layout";

export {
  clearArtifactInCanvas,
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  clearRoutineInCanvas,
  closeCanvasContent,
  focusCanvas,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  openRoutineInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  unfocusCanvas,
} from "./canvas-column-state";
export type { CanvasColumnState } from "./canvas-column-state";

export { createPendingDialogRequest } from "./pending-dialog-request";
export type { PendingDialogRequest } from "./pending-dialog-request";
