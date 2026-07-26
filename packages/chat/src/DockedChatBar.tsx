import { motion, useReducedMotion } from "framer-motion";
import { cn, dockedPanelMotion } from "@workbench/ui";

export interface DockedChatBarProps {
  /** The chat surface, typically a <ChatPanel />. */
  children: React.ReactNode;
  className?: string;
}

/**
 * Fluid height of the docked bar: a floor tall enough to breathe, scaling with
 * the viewport, capped so it never dominates a tall screen. Replaces the old
 * fixed 340px that squeezed the message thread to ~150px. The outer `min(...)`
 * caps the whole expression against available height so on a short viewport
 * (landscape tablet, docked devtools) the dock degrades instead of eating the
 * screen; on normal/tall screens the inner clamp (360–760px) governs.
 */
export const DOCKED_BAR_HEIGHT =
  "min(clamp(360px, 58vh, 760px), calc(100vh - 200px))";

/** Bottom offset from the viewport edge. */
export const DOCKED_BAR_BOTTOM = "18px";

/**
 * Total vertical space the fixed dock occupies, for the content-push spacer.
 * Derived from the dock height + bottom offset so there is ONE source of truth —
 * the spacer can never drift from the panel height.
 */
export const DOCKED_BAR_TOTAL_HEIGHT = `calc(${DOCKED_BAR_HEIGHT} + ${DOCKED_BAR_BOTTOM})`;

/**
 * A center-bottom docked overlay for the chat panel. Fixed-position, spans the
 * full shell width, centered horizontally. Pair with a same-height spacer in the
 * flex column so content above it is not hidden behind the panel.
 */
export function DockedChatBar({ children, className }: DockedChatBarProps) {
  const reduce = useReducedMotion() === true;
  const panelMotion = dockedPanelMotion(reduce);

  return (
    <motion.div
      role="complementary"
      aria-label="Chat"
      {...panelMotion}
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
