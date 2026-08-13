// `@corbits/context-menu`: the deployment-agnostic half of the global
// right-click / Ctrl-click context-menu system. Resolving a DOM event to a
// typed target (`target-resolver`), deciding whether a modal overlay should
// suppress it (`dialog-guard`), the open/position state machine
// (`use-context-menu-state`), the single document listener that drives it
// (`use-document-context-menu-trigger`), and the react-ui-backed presentation
// (`context-menu-view`) all apply to any Interchange app with typed rows to
// right-click on. What counts as a target and which items it offers is
// product-specific and stays with the consumer.

export { resolveTarget } from "./target-resolver";
export type { TargetDefinition } from "./target-resolver";

export {
  isBlockingOverlayOpen,
  isInsideInteractiveInput,
} from "./dialog-guard";

export {
  contextMenuItem,
  contextMenuSeparator,
  isContextMenuEmpty,
} from "./menu";
export type {
  ContextMenu,
  ContextMenuEntry,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./menu";

export { useContextMenuState } from "./use-context-menu-state";
export type { ContextMenuState } from "./use-context-menu-state";

export { useDocumentContextMenuTrigger } from "./use-document-context-menu-trigger";
export type { ContextMenuTriggerOptions } from "./use-document-context-menu-trigger";

export { ContextMenuView } from "./context-menu-view";
