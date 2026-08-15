// `@corbits/shell-layout`: the generic shell mechanics a second Interchange
// deployment needs — the panel-contribution registry pages register into,
// the responsive breakpoint rules and the hook that reads them, the canvas
// column and col2-width state machines, keyboard focus rescue across a
// layout-mode change, per-route scroll reset, global pins, and the
// pending-dialog-request pattern for cross-route dialog triggers. Route
// tables, per-page bands, and app-specific policy (which routes are "wide",
// what a pin points at) stay in the consuming app.

export {
  createPanelRegistry,
  panelRegistry,
  registerPanelContribution,
  resolvePanelContribution,
} from "./panel-contribution";
export type {
  PageBand,
  PanelAction,
  PanelContribution,
  PanelRegistry,
  PanelRenderContext,
} from "./panel-contribution";

export {
  canvasColumnAllowed,
  COMPACT_MAX_WIDTH,
  contextualPanelIsDrawer,
  contextualPanelVisible,
  NARROW_MAX_WIDTH,
  railShowLabels,
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

export { rescueFocusToRail, useShellFocusRescue } from "./focus-rescue";

export { useScrollReset } from "./use-scroll-reset";

export { loadPins, PinKind, savePins, togglePin, Pin } from "./pins";

export { createPendingDialogRequest } from "./pending-dialog-request";
export type { PendingDialogRequest } from "./pending-dialog-request";

export {
  COL2_ID,
  Col2EdgeHandle,
  deriveCol2Width,
  StageChromeProvider,
  useStageChrome,
} from "./stage-chrome";
export type { Col2Width, StageChrome } from "./stage-chrome";
