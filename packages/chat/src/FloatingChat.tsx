import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn, popupPanelMotion } from "@workbench/ui";

export interface FloatingChatProps {
  /** Render the panel only when open. */
  open: boolean;
  /** When true, the panel grows to a near-full-screen overlay instead of the
   *  small bottom-right popup. */
  expanded?: boolean;
  /** The chat surface, typically a <ChatPanel />. */
  children: React.ReactNode;
  /** Close the panel — wired to Escape so an expanded panel is never a trap. */
  onClose?: () => void;
  className?: string;
}

const POPUP_CLASS =
  "bottom-24 right-6 h-[32rem] max-h-[80vh] w-96 max-w-[calc(100vw-3rem)] rounded-panel border border-border shadow-xl";
const EXPANDED_CLASS = "inset-4 rounded-panel border border-border shadow-2xl";

/**
 * Floating container for the chat panel. Defaults to a small bottom-right popup;
 * when `expanded` it grows to a near-full-screen overlay (inset margin, not
 * edge-to-edge). Sits at z-40 so app modals (z-50+) still layer above it.
 * Animates in/out; open/closed and expanded are owned by the host.
 */
export function FloatingChat({
  open,
  expanded,
  children,
  onClose,
  className,
}: FloatingChatProps) {
  const reduce = useReducedMotion() === true;
  const panelMotion = popupPanelMotion(reduce);

  useEffect(() => {
    if (!open || onClose === undefined) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="floating-chat"
          role="dialog"
          aria-label="Chat"
          {...panelMotion}
          className={cn(
            "fixed z-40 flex flex-col overflow-hidden bg-bg",
            expanded === true ? EXPANDED_CLASS : POPUP_CLASS,
            className,
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
