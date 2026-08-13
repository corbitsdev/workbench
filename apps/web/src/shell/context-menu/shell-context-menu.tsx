// Mounts the global context-menu system once, at the shell root: resolves
// every right-click to a typed shell target, builds that target's real
// items, and renders them through react-ui's Menu.

import { useTheme } from "@corbits/react-ui";
import {
  ContextMenuView,
  resolveTarget,
  useContextMenuState,
  useDocumentContextMenuTrigger,
} from "@corbits/context-menu";
import { useCallback } from "react";

import { useBench } from "../../bench-context";
import { useNavigate } from "../../navigation";
import { useOpenProfileInCanvas } from "../canvas-availability";
import { shellContextMenuFor } from "./items";
import type { ShellContextMenuActions } from "./items";
import {
  SHELL_CONTEXT_MENU_FALLBACK,
  SHELL_CONTEXT_MENU_TARGETS,
} from "./targets";

export function ShellContextMenu() {
  const { selectedTenantId } = useBench();
  const navigate = useNavigate();
  const openProfile = useOpenProfileInCanvas();
  const { cycleMode } = useTheme();
  const { open, x, y, menu, show, hide } = useContextMenuState();

  const actions: ShellContextMenuActions = {
    tenantId: selectedTenantId,
    navigate,
    openProfile,
    cycleTheme: cycleMode,
  };

  const resolve = useCallback(
    (target: EventTarget | null) => {
      const resolved = resolveTarget(
        target,
        SHELL_CONTEXT_MENU_TARGETS,
        SHELL_CONTEXT_MENU_FALLBACK,
      );
      return shellContextMenuFor(resolved, actions);
    },
    // `actions` is a fresh object every render; the values it closes over
    // are what actually determine the menu, so those are the real deps.
    [selectedTenantId, navigate, openProfile, cycleMode],
  );

  useDocumentContextMenuTrigger({ resolve, onOpen: show });

  return (
    <ContextMenuView
      x={x}
      y={y}
      menu={menu}
      open={open}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
    />
  );
}
