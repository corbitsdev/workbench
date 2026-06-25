import { motion } from "framer-motion";
import { cn } from "@workbench/ui";

export interface DockedChatBarProps {
  /** The chat surface, typically a <ChatPanel />. */
  children: React.ReactNode;
  className?: string;
}

/** Height of the docked bar in pixels. Also used by the layout spacer. */
export const DOCKED_BAR_HEIGHT = 340;

/** Bottom offset from the viewport edge. */
const DOCKED_BAR_BOTTOM = 18;

/**
 * A center-bottom docked overlay for the chat panel. Fixed-position, spans the
 * full shell width, centered horizontally. Pair with a same-height spacer in the
 * flex column so content above it is not hidden behind the panel.
 */
export function DockedChatBar({ children, className }: DockedChatBarProps) {
  return (
    <motion.div
      role="complementary"
      aria-label="Chat"
      // translateX(-50%) lives in -translate-x-1/2, so Framer's y/scale
      // animation does not conflict with the centering transform.
      initial={{ y: 20, opacity: 0, scale: 0.98 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
      style={{
        width: "min(1164px, calc(100vw - 32px))",
        height: DOCKED_BAR_HEIGHT,
        bottom: DOCKED_BAR_BOTTOM,
        // z-index: above FloatingChat (z-40 / 40), below modals (z-50+ / 50+)
        zIndex: 45,
      }}
      className={cn(
        "fixed left-1/2 -translate-x-1/2",
        "flex flex-col overflow-hidden",
        "rounded-panel border border-border shadow-xl",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}
