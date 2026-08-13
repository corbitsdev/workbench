import { useCallback, useState } from "react";

import type { ContextMenu } from "./menu";

export type ContextMenuState = {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly menu: ContextMenu | null;
  /** The element that was right-clicked to open the current (or last-shown)
   * menu — where focus returns to once the menu closes. */
  readonly triggerElement: Element | null;
  readonly show: (
    x: number,
    y: number,
    menu: ContextMenu,
    triggerElement?: Element | null,
  ) => void;
  readonly hide: () => void;
};

/** Open/position state for a single context menu instance. Pure state — no
 * DOM listeners here, so it composes with any trigger source (the document
 * delegate in `use-document-context-menu-trigger`, or a row's own
 * `onContextMenu`). */
export function useContextMenuState(): ContextMenuState {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [triggerElement, setTriggerElement] = useState<Element | null>(null);

  const show = useCallback(
    (
      x: number,
      y: number,
      next: ContextMenu,
      origin: Element | null = null,
    ) => {
      setPosition({ x, y });
      setMenu(next);
      setTriggerElement(origin);
      setOpen(true);
    },
    [],
  );

  const hide = useCallback(() => {
    setOpen(false);
  }, []);

  return {
    open,
    x: position.x,
    y: position.y,
    menu,
    triggerElement,
    show,
    hide,
  };
}
