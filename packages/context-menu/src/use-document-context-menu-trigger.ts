import { useEffect } from "react";

import {
  isBlockingOverlayOpen,
  isInsideInteractiveInput,
} from "./dialog-guard";
import { isContextMenuEmpty } from "./menu";
import type { ContextMenu } from "./menu";

export type ContextMenuTriggerOptions = {
  /** Resolves the right-clicked element to a menu, or `null` for "nothing to
   * show here" (the shell background outside any known target). */
  readonly resolve: (target: EventTarget | null) => ContextMenu | null;
  /** `origin` is the element the pointer event actually landed on — the
   * caller's cue for where to restore focus once the menu closes. */
  readonly onOpen: (
    x: number,
    y: number,
    menu: ContextMenu,
    origin: Element | null,
  ) => void;
};

/**
 * Wires the single document-level `contextmenu` listener the whole app
 * shares. A native right-click still wins over ours for text inputs, and an
 * open dialog (including the command palette) always wins over opening a
 * context menu underneath it — see `dialog-guard`. `resolve` returning an
 * empty menu is the same as opting out: the native menu shows instead of an
 * empty popover.
 *
 * Deliberately right-click only. This app's `Link` already gives Ctrl/Cmd
 * click its native meaning (open in a new tab), so layering a second,
 * conflicting meaning onto it here would cost more than it gives back.
 */
export function useDocumentContextMenuTrigger(
  options: ContextMenuTriggerOptions,
): void {
  const { resolve, onOpen } = options;
  useEffect(() => {
    function handleContextMenu(event: MouseEvent): void {
      if (event.defaultPrevented) return;
      if (isInsideInteractiveInput(event.target)) return;
      if (isBlockingOverlayOpen()) return;
      const menu = resolve(event.target);
      if (isContextMenuEmpty(menu) || menu === null) return;
      event.preventDefault();
      const origin = event.target instanceof Element ? event.target : null;
      onOpen(event.clientX, event.clientY, menu, origin);
    }
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, [resolve, onOpen]);
}
