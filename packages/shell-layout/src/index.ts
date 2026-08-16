// `@corbits/shell-layout`: the generic shell mechanics a second Interchange
// deployment needs — the responsive breakpoint rules and the hook that reads
// them, the canvas column state machine, per-route scroll reset, and the
// pending-dialog-request pattern for cross-route dialog triggers. Route
// tables and app-specific policy stay in the consuming app.

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
  closeCanvasContent,
  focusCanvas,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  unfocusCanvas,
} from "./canvas-column-state";
export type { CanvasColumnState } from "./canvas-column-state";

export { useScrollReset } from "./use-scroll-reset";

export { createPendingDialogRequest } from "./pending-dialog-request";
export type { PendingDialogRequest } from "./pending-dialog-request";
