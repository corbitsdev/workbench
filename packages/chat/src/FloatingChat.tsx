import { useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@workbench/ui";

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
  useEffect(() => {
    if (!open || onClose === undefined) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <motion.div
      role="dialog"
      aria-label="Chat"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-surface",
        expanded === true ? EXPANDED_CLASS : POPUP_CLASS,
        className,
      )}
    >
      {children}
    </motion.div>
  );
}
