import { useCallback, useState } from "react";

import type { ContextMenu } from "./menu";

export type ContextMenuState = {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly menu: ContextMenu | null;
  readonly show: (x: number, y: number, menu: ContextMenu) => void;
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

  const show = useCallback((x: number, y: number, next: ContextMenu) => {
    setPosition({ x, y });
    setMenu(next);
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    setOpen(false);
  }, []);

  return { open, x: position.x, y: position.y, menu, show, hide };
}
